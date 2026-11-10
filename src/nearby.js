import path from 'node:path';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import { boundingBox, haversineMeters } from './geo.js';
import {
  ROOT_DIR,
  StopIndex,
  buildDepartures,
  isAtacBusRoute,
  nowInRome,
  parseGtfsTime,
  parseStopsCsv,
  readCsvRows,
} from './stops.js';

/**
 * Fermate vicine e prossimi passaggi.
 *
 * - `stops.txt` (~500 KB) viene letto all'avvio: l'indice delle fermate è pronto
 *   subito, quindi l'endpoint risponde anche prima che gli orari siano caricati.
 * - `stop_times.txt` (~230 MB) viene letto in background, una sola volta, e in
 *   memoria restano solo gli orari delle fermate "candidate" (quelle entro
 *   `PREFETCH_RADIUS_M` da una posizione già richiesta).
 */

const CACHE_DIR = path.join(ROOT_DIR, '.cache');

/** Oltre questo raggio non ha senso cercare: il comune di Roma è grande ~20 km. */
export const MAX_RADIUS_M = 2000;
export const DEFAULT_RADIUS_M = 500;
/** Fermate di cui conserviamo gli orari in memoria. */
const PREFETCH_RADIUS_M = 1200;
const MAX_CANDIDATE_STOPS = 1500;

function log(...args) {
  console.log('[stops]', ...args);
}

/** Percorso dello zip GTFS statico (lo scarica src/gtfs.js). */
function zipPath() {
  return path.join(CACHE_DIR, 'rome_static_gtfs.zip');
}

async function zipEntryStream(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  // adm-zip decomprime in memoria: lo stream evita di tenere una seconda copia del testo.
  const buffer = await new Promise((resolve, reject) => {
    // getDataAsync chiama callback(data, err) — attenzione all'ordine.
    entry.getDataAsync((data, err) => (err ? reject(new Error(err)) : resolve(data)));
  });
  return Readable.from([buffer]);
}

/** Scarica (in background) gli orari delle fermate indicate. */
export class StopTimesIndex {
  constructor() {
    /** @type {Map<string, {routeId: string, line: string, headsign: string, minutes: number}[]>} */
    this.byStop = new Map();
    /** @type {Set<string>} fermate di cui vogliamo gli orari */
    this.wanted = new Set();
    this.status = 'idle'; // idle | loading | ready | error
    this.error = null;
    this.loadedAt = null;
    this.date = null;
    this.tripCount = 0;
    this.promise = null;
    this.retryAfter = 0;
  }

  get ready() {
    return this.status === 'ready';
  }

  /** Aggiunge fermate a quelle di cui tenere gli orari e avvia il caricamento. */
  ensure(stopIds, { force = false } = {}) {
    let added = 0;
    for (const id of stopIds) {
      if (this.wanted.size >= MAX_CANDIDATE_STOPS && !this.wanted.has(id)) break;
      if (!this.wanted.has(id)) {
        this.wanted.add(id);
        added += 1;
      }
    }
    if (added && this.status === 'ready' && !force) {
      // Nuove fermate dopo il primo caricamento: ricarichiamo gli orari.
      this.status = 'idle';
    }
    return this.load({ force });
  }

  load({ force = false } = {}) {
    if (this.promise) return this.promise;
    if (!force && this.status === 'ready') return Promise.resolve(true);
    if (!force && Date.now() < this.retryAfter) return Promise.resolve(false);
    this.promise = this.#run(force).finally(() => {
      this.promise = null;
    });
    return this.promise;
  }

  async #run(force) {
    if (!this.wanted.size) return false;
    this.status = 'loading';
    try {
      const started = Date.now();
      const { stops: parsed, trips } = await parseTodayStopTimes(
        this.wanted,
        new Set(this.byStop.keys()),
      );
      if (force || parsed.size > 0) {
        for (const [stopId, items] of parsed) this.byStop.set(stopId, items);
      }
      this.status = 'ready';
      this.error = null;
      this.loadedAt = new Date().toISOString();
      this.date = nowInRome().date;
      this.tripCount = trips;
      log(
        `orari pronti: ${parsed.size} fermate, ${trips} corse del ${this.date} (${((Date.now() - started) / 1000).toFixed(1)} s)`,
      );
      return true;
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.retryAfter = Date.now() + 5 * 60_000;
      log(`orari non disponibili: ${err.message}`);
      return false;
    }
  }

  departuresFor(stopId) {
    return this.byStop.get(stopId) || [];
  }
}

/**
 * Scorre `stop_times.txt` e restituisce gli orari delle sole fermate `wanted`.
 * Vengono considerate solo le corse del giorno corrente delle linee bus ATAC.
 */
export async function parseTodayStopTimes(wantedStopIds, { date = nowInRome().date } = {}) {
  const zip = new AdmZip(zipPath());

  const routesEntry = zip.getEntry('routes.txt');
  const tripsEntry = zip.getEntry('trips.txt');
  const calendarEntry = zip.getEntry('calendar_dates.txt');
  const stopTimesEntry = zip.getEntry('stop_times.txt');
  if (!tripsEntry || !stopTimesEntry) {
    throw new Error('trips.txt o stop_times.txt non presenti nello zip GTFS');
  }

  const routes = new Map();
  if (routesEntry) {
    for await (const row of readCsvRows(await zipEntryStream(zip, 'routes.txt'))) {
      if (!row.route_id) continue;
      routes.set(row.route_id, {
        id: row.route_id,
        agencyId: row.agency_id,
        name: (row.route_short_name || row.route_id).trim(),
        type: String(row.route_type),
      });
    }
  }

  // service_id attivi nella data indicata (exception_type = 1)
  const activeServices = new Set();
  if (calendarEntry) {
    for await (const row of readCsvRows(await zipEntryStream(zip, 'calendar_dates.txt'))) {
      if (row.date === date && row.exception_type === '1') activeServices.add(row.service_id);
    }
  }

  // trip_id -> { routeId, line, headsign }
  const trips = new Map();
  for await (const row of readCsvRows(await zipEntryStream(zip, 'trips.txt'))) {
    if (!row.trip_id) continue;
    if (activeServices.size && !activeServices.has(row.service_id)) continue;
    const route = routes.get(row.route_id);
    if (route && !isAtacBusRoute(route)) continue;
    trips.set(row.trip_id, {
      routeId: row.route_id,
      line: route ? route.name : row.route_id,
      headsign: (row.trip_headsign || '').trim(),
    });
  }

  const result = new Map();
  for await (const row of readCsvRows(await zipEntryStream(zip, 'stop_times.txt'))) {
    if (!row.stop_id || !wantedStopIds.has(row.stop_id)) continue;
    const trip = trips.get(row.trip_id);
    if (!trip) continue;
    const minutes = parseGtfsTime(row.departure_time || row.arrival_time);
    if (minutes === null) continue;

    let list = result.get(row.stop_id);
    if (!list) {
      list = [];
      result.set(row.stop_id, list);
    }
    list.push({
      stopId: row.stop_id,
      routeId: trip.routeId,
      line: trip.line,
      headsign: trip.headsign,
      minutes,
    });
  }

  return { stops: result, trips: trips.size };
}

/** Carica l'indice delle fermate da `stops.txt`. */
export async function loadStops() {
  const zip = new AdmZip(zipPath());
  const entry = zip.getEntry('stops.txt');
  if (!entry) throw new Error('stops.txt non presente nello zip GTFS');
  const text = entry.getData().toString('utf8');
  const stops = parseStopsCsv(text);
  log(`indice fermate: ${stops.length}`);
  return new StopIndex(stops);
}

/**
 * Servizio "fermate vicine": mette insieme indice spaziale, orari e feed
 * delle posizioni per capire quali linee stanno arrivando davvero.
 */
export class NearbyService {
  constructor({ stopIndex, stopTimes, staticData, getSnapshot, now = () => new Date() }) {
    this.stopIndex = stopIndex;
    this.stopTimes = stopTimes;
    this.staticData = staticData;
    this.getSnapshot = getSnapshot;
    this.now = now;
  }

  /**
   * @param {{lat:number, lon:number, radius?:number, limit?:number}} query
   */
  async nearby({ lat, lon, radius = DEFAULT_RADIUS_M, limit = 10 } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error('Coordinate non valide');
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error('Coordinate fuori intervallo');
    }

    const searchRadius = Math.min(MAX_RADIUS_M, Math.max(50, Number(radius) || DEFAULT_RADIUS_M));
    const center = { lat, lon };

    // Le fermate nel raggio allargato diventano "candidate" per gli orari.
    const candidates = this.stopIndex.nearby(center, PREFETCH_RADIUS_M, { limit: MAX_CANDIDATE_STOPS });
    const stops = candidates
      .filter((s) => s.distance <= searchRadius)
      .slice(0, Math.min(50, Math.max(1, Number(limit) || 10)));

    if (stops.length) {
      this.stopTimes.ensure(candidates.map((s) => s.id));
    }

    const { date, minutes: nowMinutes } = nowInRome(this.now());

    // Posizioni reali dei bus: servono a mostrare solo linee effettivamente in giro.
    const activeRoutes = new Map(); // routeId -> { count, nearest: {...} }
    try {
      const snapshot = await this.getSnapshot();
      for (const v of snapshot.vehicles || []) {
        const entry = activeRoutes.get(v.routeId) || { count: 0, nearest: null };
        entry.count += 1;
        const distance = haversineMeters(center, v);
        if (!entry.nearest || distance < entry.nearest.distance) {
          entry.nearest = { distance, label: v.label, status: v.status, speedKmh: v.speedKmh, direction: v.direction };
        }
        activeRoutes.set(v.routeId, entry);
      }
    } catch {
      /* senza feed mostriamo comunque gli orari programmati */
    }

    const result = stops.map((stop) => {
      const scheduled = this.stopTimes.departuresFor(stop.id);
      const departures = buildDepartures(scheduled, {
        nowMinutes,
        perStop: 6,
      }).get(stop.id) || [];

      const lines = departures.map((dep) => {
        const active = activeRoutes.get(dep.routeId) || null;
        const route = this.staticData?.routeById?.get(dep.routeId) || null;
        return {
          routeId: dep.routeId,
          line: dep.line,
          headsign: dep.headsign || route?.headsigns?.[0] || '',
          waitMinutes: dep.waitMinutes,
          activeBuses: active?.count || 0,
          nearestBusMeters: active?.nearest ? Math.round(active.nearest.distance) : null,
          nearestBusLabel: active?.nearest?.label || null,
        };
      });

      return {
        id: stop.id,
        code: stop.code,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        distance: Math.round(stop.distance),
        lines,
      };
    });

    return {
      generatedAt: this.now().toISOString(),
      center,
      radius: searchRadius,
      schedule: {
        ready: this.stopTimes.ready,
        status: this.stopTimes.status,
        date,
        nowMinutes,
        updatedAt: this.stopTimes.loadedAt,
        error: this.stopTimes.error,
      },
      stops: result,
    };
  }
}

/** Riquadro attorno al punto, usato dai test e dal client. */
export function searchBox(center, radius) {
  return boundingBox(center, radius);
}

export { zipPath };
