import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const FEED_URL =
  process.env.ATAC_RT_URL ||
  'https://romamobilita.it/sites/default/files/rome_rtgtfs_vehicle_positions_feed.pb';

// Riquadro generoso del comune di Roma: serve solo a scartare posizioni GPS palesemente errate.
const BBOX = { minLat: 41.55, maxLat: 42.25, minLon: 12.0, maxLon: 12.95 };

const OCCUPANCY = {
  0: 'Vuoto',
  1: 'Molti posti liberi',
  2: 'Pochi posti liberi',
  3: 'Solo in piedi',
  4: 'Molto affollato',
  5: 'Pieno',
  6: 'Non accetta passeggeri',
  7: 'Dato non disponibile',
  8: 'Non salibile',
};

const CURRENT_STATUS = {
  0: 'In arrivo',
  1: 'Alla fermata',
  2: 'In transito',
  INCOMING_AT: 'In arrivo',
  STOPPED_AT: 'Alla fermata',
  IN_TRANSIT_TO: 'In transito',
};

function enumValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return value;
}

function occupancyLabel(value) {
  if (value === undefined || value === null) return null;
  const key = enumValue(value);
  return OCCUPANCY[key] || null;
}

function statusLabel(value, speedKmh) {
  if (value === undefined || value === null) {
    return speedKmh > 2 ? 'In movimento' : 'Fermo';
  }
  return CURRENT_STATUS[enumValue(value)] || 'In transito';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function inRome(lat, lon) {
  return (
    lat >= BBOX.minLat &&
    lat <= BBOX.maxLat &&
    lon >= BBOX.minLon &&
    lon <= BBOX.maxLon
  );
}

function sortByLine(a, b) {
  const byLine = a.line.localeCompare(b.line, 'it', { numeric: true, sensitivity: 'base' });
  if (byLine !== 0) return byLine;
  return a.label.localeCompare(b.label, 'it', { numeric: true });
}

export async function fetchSnapshot(staticData) {
  const res = await fetch(FEED_URL, {
    redirect: 'follow',
    headers: {
      accept: 'application/x-protobuf, application/octet-stream, */*',
      'user-agent': 'atac-bus-live/1.0 (+open data Roma Mobilità)',
    },
  });
  if (!res.ok) throw new Error(`Feed posizioni: HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const message = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

  const byVehicle = new Map();
  let discarded = 0;

  for (const entity of message.entity || []) {
    const v = entity.vehicle;
    if (!v || entity.isDeleted) continue;

    const routeId = v.trip?.routeId;
    if (!routeId) {
      discarded += 1;
      continue;
    }

    const route = staticData.routeById.get(routeId);
    if (!route) {
      // Non è una linea ATAC (bus) oppure non è nel GTFS statico.
      discarded += 1;
      continue;
    }

    const lat = toNumber(v.position?.latitude);
    const lon = toNumber(v.position?.longitude);
    if (lat === null || lon === null || !inRome(lat, lon)) {
      discarded += 1;
      continue;
    }

    const speedMs = toNumber(v.position?.speed);
    const speedKmh = speedMs === null ? null : Math.round(speedMs * 3.6);

    const direction = v.trip?.directionId === 1 ? 1 : 0;
    const id = v.vehicle?.id || v.vehicle?.label || `${routeId}-${lat}-${lon}`;
    const timestamp = toNumber(v.timestamp) || toNumber(message.header?.timestamp) || null;

    const bus = {
      id: String(id),
      label: String(v.vehicle?.label || v.vehicle?.id || id),
      routeId,
      line: route.name,
      direction,
      headsign: route.headsigns[direction] || route.headsigns[0] || '',
      lat,
      lon,
      bearing: toNumber(v.position?.bearing),
      speedKmh,
      status: statusLabel(v.currentStatus, speedKmh ?? 0),
      occupancy: occupancyLabel(v.occupancyStatus),
      stopId: v.stopId ? String(v.stopId) : null,
      startDate: v.trip?.startDate || null,
      startTime: v.trip?.startTime || null,
      timestamp,
    };

    const previous = byVehicle.get(bus.id);
    if (!previous || (bus.timestamp || 0) >= (previous.timestamp || 0)) {
      byVehicle.set(bus.id, bus);
    }
  }

  const vehicles = [...byVehicle.values()].sort(sortByLine);
  const lines = new Set(vehicles.map((v) => v.routeId));
  const moving = vehicles.filter((v) => v.status === 'In transito').length;

  const feedTimestamp = toNumber(message.header?.timestamp);

  return {
    generatedAt: new Date().toISOString(),
    feedTimestamp: feedTimestamp ? new Date(feedTimestamp * 1000).toISOString() : null,
    stats: {
      total: vehicles.length,
      lines: lines.size,
      moving,
      stopped: vehicles.length - moving,
      discarded,
    },
    vehicles,
  };
}
