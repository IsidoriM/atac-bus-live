import test from 'node:test';
import assert from 'node:assert/strict';
import { NearbyService, MAX_RADIUS_M } from '../src/nearby.js';
import { StopIndex, nowInRome } from '../src/stops.js';

const STOPS = [
  { id: 'A', code: 'A', name: 'FERMATA A', lat: 41.9013, lon: 12.5004 },
  { id: 'B', code: 'B', name: 'FERMATA B', lat: 41.9030, lon: 12.5010 },
  { id: 'C', code: 'C', name: 'FERMATA LONTANA', lat: 41.95, lon: 12.60 },
];

function makeService({ vehicles = [], now = new Date('2026-11-10T08:30:00Z') } = {}) {
  const stopIndex = new StopIndex(STOPS);
  const wanted = [];
  const { minutes } = nowInRome(now);
  const schedules = {
    A: [
      { stopId: 'A', routeId: '105', line: '105', headsign: 'P.za Venezia', minutes: minutes + 3 },
      { stopId: 'A', routeId: '62', line: '62', headsign: 'Stazione', minutes: minutes + 8 },
    ],
    B: [{ stopId: 'B', routeId: '105', line: '105', headsign: 'P.za Venezia', minutes: minutes + 12 }],
  };

  const stopTimes = {
    status: 'ready',
    ready: true,
    loadedAt: now.toISOString(),
    error: null,
    ensure(ids) {
      wanted.push(...ids);
      return Promise.resolve(true);
    },
    departuresFor: (id) => schedules[id] || [],
  };

  const staticData = {
    routeById: new Map([
      ['105', { id: '105', headsigns: ['P.za Venezia', 'Roma Termini'] }],
      ['62', { id: '62', headsigns: ['Stazione', 'Via Tiburtina'] }],
    ]),
  };

  const service = new NearbyService({
    stopIndex,
    stopTimes,
    staticData,
    getSnapshot: async () => ({ vehicles }),
    now: () => now,
  });

  return { service, wanted, schedules, minutes };
}

test('nearby: elenca le fermate nel raggio con i prossimi passaggi', async () => {
  const { service, wanted } = makeService();
  const data = await service.nearby({ lat: 41.9013, lon: 12.5004, radius: 500 });

  assert.equal(data.stops.length, 2, 'la fermata lontana resta fuori');
  assert.equal(data.stops[0].id, 'A');
  assert.ok(data.stops[0].distance <= data.stops[1].distance);
  assert.deepEqual(
    data.stops[0].lines.map((l) => l.routeId),
    ['105', '62'],
  );
  assert.equal(data.stops[0].lines[0].waitMinutes, 3);
  assert.equal(data.stops[0].lines[0].headsign, 'P.za Venezia');
  assert.ok(wanted.includes('A'), 'le fermate vicine diventano candidate per gli orari');
  assert.equal(data.schedule.ready, true);
  assert.equal(data.radius, 500);
});

test('nearby: arricchisce le linee con i bus realmente in circolazione', async () => {
  const { service } = makeService({
    vehicles: [
      { id: '1', label: '0101', routeId: '105', lat: 41.9020, lon: 12.5010, status: 'In transito', speedKmh: 20, direction: 0 },
      { id: '2', label: '0102', routeId: '105', lat: 41.9040, lon: 12.5030, status: 'In transito', speedKmh: 12, direction: 0 },
    ],
  });

  const data = await service.nearby({ lat: 41.9013, lon: 12.5004 });
  const line105 = data.stops[0].lines.find((l) => l.routeId === '105');
  assert.equal(line105.activeBuses, 2);
  assert.equal(line105.nearestBusLabel, '0101');
  assert.ok(line105.nearestBusMeters > 0);

  const line62 = data.stops[0].lines.find((l) => l.routeId === '62');
  assert.equal(line62.activeBuses, 0);
  assert.equal(line62.nearestBusMeters, null);
});

test('nearby: se il feed posizioni non risponde restano gli orari programmati', async () => {
  const stopIndex = new StopIndex(STOPS);
  const service = new NearbyService({
    stopIndex,
    stopTimes: {
      status: 'idle',
      ready: false,
      error: null,
      ensure: () => Promise.resolve(false),
      departuresFor: () => [],
    },
    staticData: { routeById: new Map() },
    getSnapshot: async () => {
      throw new Error('feed offline');
    },
    now: () => new Date('2026-11-10T08:30:00Z'),
  });

  const data = await service.nearby({ lat: 41.9013, lon: 12.5004 });
  assert.equal(data.stops.length, 2);
  assert.deepEqual(data.stops[0].lines, []);
  assert.equal(data.schedule.ready, false);
});

test('nearby: coordinate non valide', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.nearby({ lat: Number.NaN, lon: 12.5 }), /Coordinate non valide/);
  await assert.rejects(() => service.nearby({ lat: 100, lon: 12.5 }), /fuori intervallo/);
});

test('nearby: il raggio viene limitato a un massimo sensato', async () => {
  const { service } = makeService();
  const data = await service.nearby({ lat: 41.9013, lon: 12.5004, radius: 999_999 });
  assert.equal(data.radius, MAX_RADIUS_M);

  const tiny = await service.nearby({ lat: 41.9013, lon: 12.5004, radius: 1 });
  assert.equal(tiny.radius, 50, 'sotto i 50 m si arrotonda al minimo');
});

test('nearby: rispetta il limite di fermate richieste', async () => {
  const { service } = makeService();
  const data = await service.nearby({ lat: 41.9013, lon: 12.5004, radius: 1000, limit: 1 });
  assert.equal(data.stops.length, 1);
});
