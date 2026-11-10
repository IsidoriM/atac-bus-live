import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundingBox,
  distanceToPolylineMeters,
  distanceToSegmentMeters,
  formatDistance,
  formatWait,
  haversineMeters,
  polylineLengthMeters,
} from '../src/geo.js';

const COLOSSEUM = { lat: 41.89021, lon: 12.492231 };
const TERMINI = { lat: 41.9010, lon: 12.5006 };

test('haversineMeters: distanza nota tra Colosseo e Termini', () => {
  const d = haversineMeters(COLOSSEUM, TERMINI);
  assert.ok(d > 1100 && d < 1400, `distanza inattesa: ${d}`);
});

test('haversineMeters: distanza nulla per lo stesso punto', () => {
  assert.equal(haversineMeters(COLOSSEUM, { ...COLOSSEUM }), 0);
});

test('boundingBox: contiene il centro e cresce con il raggio', () => {
  const box = boundingBox(COLOSSEUM, 500);
  assert.ok(box.minLat < COLOSSEUM.lat && box.maxLat > COLOSSEUM.lat);
  assert.ok(box.minLon < COLOSSEUM.lon && box.maxLon > COLOSSEUM.lon);

  const wide = boundingBox(COLOSSEUM, 1000);
  assert.ok(wide.maxLat > box.maxLat);
  assert.ok(wide.maxLon > box.maxLon);
});

test('distanceToSegmentMeters: punto sopra il segmento', () => {
  // ~111 m a nord di un segmento orizzontale
  const a = { lat: 41.89, lon: 12.49 };
  const b = { lat: 41.89, lon: 12.5 };
  const p = { lat: 41.891, lon: 12.495 };
  const d = distanceToSegmentMeters(p, a, b);
  assert.ok(Math.abs(d - 111) < 6, `distanza inattesa: ${d}`);
});

test('distanceToSegmentMeters: punto oltre l’estremo usa l’estremo', () => {
  const a = { lat: 41.89, lon: 12.49 };
  const b = { lat: 41.89, lon: 12.5 };
  const p = { lat: 41.89, lon: 12.6 };
  const d = distanceToSegmentMeters(p, a, b);
  assert.ok(Math.abs(d - haversineMeters(p, b)) < 5, `distanza inattesa: ${d}`);
});

test('distanceToPolylineMeters: polilinea vuota o di un punto', () => {
  assert.equal(distanceToPolylineMeters(COLOSSEUM, []), Infinity);
  const d = distanceToPolylineMeters(COLOSSEUM, [[COLOSSEUM.lat, COLOSSEUM.lon]]);
  assert.ok(d < 1);
});

test('distanceToPolylineMeters: minimo tra i segmenti', () => {
  const points = [
    [41.88, 12.48],
    [41.88, 12.50],
    [41.90, 12.50],
  ];
  const onLine = distanceToPolylineMeters({ lat: 41.88, lon: 12.49 }, points);
  assert.ok(onLine < 5, `distanza inattesa: ${onLine}`);

  const far = distanceToPolylineMeters({ lat: 41.95, lon: 12.49 }, points);
  assert.ok(far > 5000);
});

test('polylineLengthMeters: somma dei lati', () => {
  const points = [
    [41.89, 12.49],
    [41.89, 12.5],
  ];
  const length = polylineLengthMeters(points);
  const direct = haversineMeters({ lat: 41.89, lon: 12.49 }, { lat: 41.89, lon: 12.5 });
  assert.ok(Math.abs(length - direct) < 1);
  assert.equal(polylineLengthMeters([[41.89, 12.49]]), 0);
});

test('formatDistance', () => {
  assert.equal(formatDistance(120), '120 m');
  assert.equal(formatDistance(1234), '1,2 km');
  assert.equal(formatDistance(999), '1,0 km');
  assert.equal(formatDistance(NaN), '');
});

test('formatWait', () => {
  assert.equal(formatWait(0), 'in arrivo');
  assert.equal(formatWait(-2), 'in arrivo');
  assert.equal(formatWait(1), '1 min');
  assert.equal(formatWait(7), '7 min');
});
