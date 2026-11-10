import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const ZIP_PATH = path.join(CACHE_DIR, 'rome_static_gtfs.zip');

const GTFS_URL =
  process.env.GTFS_URL ||
  'https://romamobilita.it/sites/default/files/rome_static_gtfs.zip';

const MAX_AGE_MS = (Number(process.env.GTFS_MAX_AGE_HOURS) || 24) * 60 * 60 * 1000;

// ATAC (agenzia del comune di Roma) e autobus (route_type 3 = bus/filobus)
const ATAC_AGENCY = process.env.ATAC_AGENCY_ID || 'OP1';
const BUS_ROUTE_TYPE = '3';

function log(...args) {
  console.log(`[gtfs]`, ...args);
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

function readCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = parseCsvLine(lines[0] || '');
  return { header, lines };
}

function rowToObject(header, line) {
  const values = parseCsvLine(line);
  const row = {};
  for (let i = 0; i < header.length; i += 1) row[header[i]] = values[i] ?? '';
  return row;
}

function forEachRow(text, cb) {
  const { header, lines } = readCsv(text);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line) cb(rowToObject(header, line));
  }
}

async function ensureZip() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });

  let stat = null;
  try {
    stat = await fsp.stat(ZIP_PATH);
  } catch {
    /* not cached yet */
  }

  const isFresh = stat && Date.now() - stat.mtimeMs < MAX_AGE_MS;
  if (isFresh && !process.env.GTFS_FORCE_DOWNLOAD) {
    log(`GTFS statico in cache (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    return ZIP_PATH;
  }

  log('scarico il GTFS statico da Roma Mobilità...');
  try {
    const res = await fetch(GTFS_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const tmp = `${ZIP_PATH}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, ZIP_PATH);
    log(`GTFS statico scaricato (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    return ZIP_PATH;
  } catch (err) {
    if (stat) {
      log(`download fallito (${err.message}), uso la cache esistente`);
      return ZIP_PATH;
    }
    throw new Error(`Impossibile scaricare il GTFS statico: ${err.message}`);
  }
}

function parseRoutes(zip) {
  const entry = zip.getEntry('routes.txt');
  if (!entry) throw new Error('routes.txt non presente nello zip GTFS');

  const routes = new Map();
  forEachRow(entry.getData().toString('utf8'), (r) => {
    if (!r.route_id) return;
    routes.set(r.route_id, {
      id: r.route_id,
      agencyId: r.agency_id,
      shortName: (r.route_short_name || r.route_id).trim(),
      longName: (r.route_long_name || '').trim(),
      type: String(r.route_type),
    });
  });
  return routes;
}

function parseTrips(zip, atacBusRoutes) {
  const entry = zip.getEntry('trips.txt');
  if (!entry) throw new Error('trips.txt non presente nello zip GTFS');

  const stats = new Map(); // routeId -> { trips, headsigns[dir]: Map, shapes[dir]: Map }
  forEachRow(entry.getData().toString('utf8'), (t) => {
    if (!atacBusRoutes.has(t.route_id)) return;
    const direction = t.direction_id === '1' ? 1 : 0;
    let s = stats.get(t.route_id);
    if (!s) {
      s = {
        trips: 0,
        headsigns: [new Map(), new Map()],
        shapes: [new Map(), new Map()],
      };
      stats.set(t.route_id, s);
    }
    s.trips += 1;
    const headsign = (t.trip_headsign || '').trim();
    if (headsign) {
      const h = s.headsigns[direction];
      h.set(headsign, (h.get(headsign) || 0) + 1);
    }
    if (t.shape_id) {
      const sh = s.shapes[direction];
      sh.set(t.shape_id, (sh.get(t.shape_id) || 0) + 1);
    }
  });
  return stats;
}

function topKey(counts) {
  let best = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function buildRouteIndex(routes, stats) {
  const list = [];
  for (const [routeId, s] of stats) {
    const route = routes.get(routeId);
    if (!route) continue;
    list.push({
      id: routeId,
      name: route.shortName,
      longName: route.longName,
      tripCount: s.trips,
      headsigns: [topKey(s.headsigns[0]) || '', topKey(s.headsigns[1]) || ''],
      shapeIds: [topKey(s.shapes[0]), topKey(s.shapes[1])],
    });
  }

  list.sort((a, b) =>
    a.name.localeCompare(b.name, 'it', { numeric: true, sensitivity: 'base' }),
  );
  return list;
}

function parseShapes(zip, wantedShapeIds) {
  const entry = zip.getEntry('shapes.txt');
  if (!entry) {
    log('shapes.txt non presente: le linee verranno mostrate senza tracciato');
    return new Map();
  }

  const raw = new Map(); // shapeId -> [{seq, lat, lon}]
  forEachRow(entry.getData().toString('utf8'), (s) => {
    if (!wantedShapeIds.has(s.shape_id)) return;
    const lat = Number(s.shape_pt_lat);
    const lon = Number(s.shape_pt_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    let pts = raw.get(s.shape_id);
    if (!pts) {
      pts = [];
      raw.set(s.shape_id, pts);
    }
    pts.push({ seq: Number(s.shape_pt_sequence), lat, lon });
  });

  const shapes = new Map();
  for (const [shapeId, pts] of raw) {
    pts.sort((a, b) => a.seq - b.seq);
    shapes.set(
      shapeId,
      pts.map((p) => [Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6))]),
    );
  }
  return shapes;
}

export async function loadGtfsData() {
  const zipPath = await ensureZip();
  const zip = new AdmZip(zipPath);

  log('analizzo le linee...');
  const routes = parseRoutes(zip);
  const atacBusRoutes = new Map();
  for (const [id, route] of routes) {
    if (route.agencyId === ATAC_AGENCY && route.type === BUS_ROUTE_TYPE) {
      atacBusRoutes.set(id, route);
    }
  }
  if (atacBusRoutes.size === 0) {
    throw new Error(`Nessuna linea ATAC trovata (agenzia ${ATAC_AGENCY})`);
  }

  log('analizzo le corse...');
  const stats = parseTrips(zip, atacBusRoutes);
  const routesList = buildRouteIndex(routes, stats);

  const routeById = new Map(routesList.map((r) => [r.id, r]));

  const wantedShapeIds = new Set();
  for (const route of routesList) {
    for (const shapeId of route.shapeIds) if (shapeId) wantedShapeIds.add(shapeId);
  }
  log('carico i tracciati...');
  const shapes = parseShapes(zip, wantedShapeIds);

  const totalTrips = routesList.reduce((sum, r) => sum + r.tripCount, 0);
  log(
    `pronto: ${routesList.length} linee ATAC, ${totalTrips} corse, ${shapes.size} tracciati`,
  );

  return { routeById, routes: routesList, shapes };
}
