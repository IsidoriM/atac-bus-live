import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundingBox, haversineMeters } from './geo.js';

/**
 * Fermate ATAC e passaggi programmati per il giorno corrente.
 *
 * `stop_times.txt` del GTFS di Roma Mobilità pesa oltre 200 MB, quindi non viene
 * letto al primo avvio: lo si carica in background e si tiene in memoria solo
 * l'orario delle fermate candidate (le più vicine a chi usa l'app).
 */

const BUS_ROUTE_TYPE = '3';

/** Oltre questo orizzonte un passaggio programmato non è più utile alla fermata. */
export const MAX_WAIT_MINUTES = 180;

const ROME_TZ = 'Europe/Rome';

/** Istantanea del giorno corrente: {date, minutes} nel fuso di Roma. */
export function nowInRome(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ROME_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}${get('month')}${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/** "07:28:00" / "25:10:00" -> minuti dalla mezzanotte (anche oltre 1440). */
export function parseGtfsTime(value) {
  const m = /^\s*(\d{1,3}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function parseCsvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Legge un file CSV GTFS riga per riga: `onRow(obj)` riceve un oggetto
 * {colonna: valore}. Il file viene scorso a blocchi per non tenere in memoria
 * centinaia di MB di testo.
 */
export async function* readCsvRows(stream) {
  let header = null;
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (header === null) {
        header = parseCsvLine(line.replace(/^\uFEFF/, ''));
      } else if (line) {
        yield rowFromLine(header, line);
      }
      index = buffer.indexOf('\n');
    }
  }
  if (buffer) {
    const line = buffer.replace(/\r$/, '');
    if (header === null) header = parseCsvLine(line.replace(/^\uFEFF/, ''));
    else if (line) yield rowFromLine(header, line);
  }
}

function rowFromLine(header, line) {
  const values = parseCsvLine(line);
  const row = {};
  for (let i = 0; i < header.length; i += 1) row[header[i]] = values[i] ?? '';
  return row;
}

/** Legge `stops.txt` e restituisce le fermate fisiche (location_type 0). */
export function parseStopsCsv(text) {
  const stops = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = parseCsvLine(lines[0] || '');
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const row = rowFromLine(header, lines[i]);
    if (!row.stop_id) continue;
    // location_type: 0 fermata, 1 stazione, 2 ingresso, 3 nodo, 4 area
    if (row.location_type && row.location_type !== '0') continue;
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stops.push({
      id: row.stop_id,
      code: row.stop_code || '',
      name: (row.stop_name || '').trim(),
      lat,
      lon,
    });
  }
  return stops;
}

/**
 * Indice spaziale delle fermate: griglia di celle da ~250 m per non dover
 * scandire tutte le ~8.000 fermate a ogni richiesta.
 */
export class StopIndex {
  constructor(stops, { cellDegrees = 0.0025 } = {}) {
    this.stops = stops;
    this.byId = new Map(stops.map((s) => [s.id, s]));
    this.cellDegrees = cellDegrees;
    this.cells = new Map();
    for (const stop of stops) {
      const key = this.cellKey(stop.lat, stop.lon);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(stop);
    }
  }

  cellKey(lat, lon) {
    return `${Math.floor(lat / this.cellDegrees)}:${Math.floor(lon / this.cellDegrees)}`;
  }

  /**
   * Fermate entro `radiusMeters` dal punto `center`, ordinate per distanza.
   * `limit` limita il numero di risultati restituiti.
   */
  nearby(center, radiusMeters, { limit = 12 } = {}) {
    const box = boundingBox(center, radiusMeters);
    const minRow = Math.floor(box.minLat / this.cellDegrees);
    const maxRow = Math.floor(box.maxLat / this.cellDegrees);
    const minCol = Math.floor(box.minLon / this.cellDegrees);
    const maxCol = Math.floor(box.maxLon / this.cellDegrees);

    const found = [];
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const bucket = this.cells.get(`${row}:${col}`);
        if (!bucket) continue;
        for (const stop of bucket) {
          const distance = haversineMeters(center, stop);
          if (distance <= radiusMeters) found.push({ ...stop, distance });
        }
      }
    }

    found.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'it'));
    return found.slice(0, limit);
  }
}

/**
 * Calcola, per un elenco di fermate, i prossimi passaggi dei bus ATAC a partire
 * dai passaggi programmati `{stopId, routeId, minutes}` del giorno corrente.
 *
 * I passaggi vengono raggruppati per fermata + linea e ordinati per orario;
 * quelli già passati da più di `graceMinutes` minuti vengono scartati (il
 * feed statico non conosce i ritardi reali).
 */
export function buildDepartures(
  scheduled,
  { nowMinutes, graceMinutes = 1, perStop = 6, maxWaitMinutes = MAX_WAIT_MINUTES } = {},
) {
  const byStop = new Map();

  for (const item of scheduled) {
    if (!item || !item.stopId || !item.routeId) continue;
    if (!Number.isFinite(item.minutes)) continue;
    const wait = item.minutes - nowMinutes;
    // I giorni GTFS possono superare le 24 ore (corse notturne): oltre le 3 ore
    // non è un "prossimo passaggio" utile per chi è alla fermata.
    if (wait < -graceMinutes || wait > maxWaitMinutes) continue;

    let entry = byStop.get(item.stopId);
    if (!entry) {
      entry = { stopId: item.stopId, lines: new Map() };
      byStop.set(item.stopId, entry);
    }

    // Una voce per linea: tiene il primo passaggio utile tra le due direzioni.
    let line = entry.lines.get(item.routeId);
    if (!line) {
      line = {
        routeId: item.routeId,
        line: item.line || item.routeId,
        headsign: item.headsign || '',
        waitMinutes: Math.round(wait),
      };
      entry.lines.set(item.routeId, line);
    } else if (wait < line.waitMinutes) {
      line.headsign = item.headsign || line.headsign;
      line.waitMinutes = Math.round(wait);
    }
  }

  const result = new Map();
  for (const [stopId, entry] of byStop) {
    const lines = [...entry.lines.values()]
      .sort((a, b) => a.waitMinutes - b.waitMinutes || a.line.localeCompare(b.line, 'it', { numeric: true }));
    result.set(stopId, lines.slice(0, perStop));
  }
  return result;
}

/** Vero se il percorso è una linea bus ATAC. */
export function isAtacBusRoute(route) {
  return Boolean(route) && route.agencyId === (process.env.ATAC_AGENCY_ID || 'OP1') && String(route.type) === BUS_ROUTE_TYPE;
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
