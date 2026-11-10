// Utility geografiche pure: nessuna dipendenza, facili da testare.

export const EARTH_RADIUS_M = 6_371_000;
/** Metri per grado di latitudine (media WGS84), usati per le approssimazioni locali. */
export const METERS_PER_DEGREE_LAT = 111_195;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Distanza in metri tra due punti {lat, lon} (formula dell'emisenoverso). */
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Riquadro {minLat, maxLat, minLon, maxLon} attorno a un punto, con raggio in metri. */
export function boundingBox(center, radiusMeters) {
  const dLat = radiusMeters / METERS_PER_DEGREE_LAT;
  const cos = Math.cos(toRad(center.lat));
  const dLon = radiusMeters / (METERS_PER_DEGREE_LAT * Math.max(0.01, Math.abs(cos)));
  return {
    minLat: center.lat - dLat,
    maxLat: center.lat + dLat,
    minLon: center.lon - dLon,
    maxLon: center.lon + dLon,
  };
}

/**
 * Distanza in metri tra il punto p e il segmento [a, b], calcolata in un piano
 * locale: su distanze urbane (poche centinaia di metri) l'errore è trascurabile.
 */
export function distanceToSegmentMeters(p, a, b) {
  const cosLat = Math.cos(toRad((p.lat + a.lat + b.lat) / 3));
  // Proiezione in metri (est, nord) con origine nel punto p.
  const project = (q) => ({
    x: (q.lon - p.lon) * METERS_PER_DEGREE_LAT * cosLat,
    y: (q.lat - p.lat) * METERS_PER_DEGREE_LAT,
  });

  const pa = project(a);
  const pb = project(b);
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const lengthSq = vx * vx + vy * vy;

  // p è nell'origine: proiettiamo (0,0) sul segmento e limitiamo a [0, 1].
  let t = lengthSq === 0 ? 0 : -(pa.x * vx + pa.y * vy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(pa.x + vx * t, pa.y + vy * t);
}

/** Distanza minima in metri tra un punto e una polilinea [[lat, lon], ...]. */
export function distanceToPolylineMeters(p, points) {
  if (!Array.isArray(points) || points.length === 0) return Infinity;
  if (points.length === 1) return haversineMeters(p, { lat: points[0][0], lon: points[0][1] });

  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = { lat: points[i - 1][0], lon: points[i - 1][1] };
    const b = { lat: points[i][0], lon: points[i][1] };
    const d = distanceToSegmentMeters(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

/** Distanza in metri (arrotondata) lungo una polilinea, per ordinare i passaggi. */
export function polylineLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMeters(
      { lat: points[i - 1][0], lon: points[i - 1][1] },
      { lat: points[i][0], lon: points[i][1] },
    );
  }
  return total;
}

/** "350 m", "1,4 km" */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

/** "12:05" oppure "fra 3 min" */
export function formatWait(minutes) {
  if (!Number.isFinite(minutes)) return '';
  if (minutes <= 0) return 'in arrivo';
  if (minutes === 1) return '1 min';
  return `${minutes} min`;
}
