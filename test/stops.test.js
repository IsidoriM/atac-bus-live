import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  StopIndex,
  buildDepartures,
  isAtacBusRoute,
  nowInRome,
  parseGtfsTime,
  parseStopsCsv,
  readCsvRows,
} from '../src/stops.js';

const STOPS_CSV = `stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,stop_url,wheelchair_boarding,stop_timezone,location_type,parent_station
05000,05000,"TERMINI (MA-MB-FS)",,41.901308,12.500433,,,,,
05001,05001,"NERVI/PALAZZO SPORT",,41.823818,12.466082,,,,,
05002,05002,"FERMATA ""QUOTATA""",,41.900000,12.500000,,,,,
05003,05003,"STAZIONE",,41.901000,12.501000,,,,1,,
05004,05004,"CAPOLINEA",,41.905000,12.510000,,,,0,,
`;

test('parseGtfsTime: orari normali e dopo mezzanotte', () => {
  assert.equal(parseGtfsTime('07:28:00'), 7 * 60 + 28);
  assert.equal(parseGtfsTime('25:10:00'), 25 * 60 + 10);
  assert.equal(parseGtfsTime('00:00'), 0);
  assert.equal(parseGtfsTime(''), null);
  assert.equal(parseGtfsTime('abc'), null);
  assert.equal(parseGtfsTime(undefined), null);
});

test('nowInRome: data nel formato GTFS e minuti dalla mezzanotte', () => {
  const { date, minutes } = nowInRome(new Date('2026-11-10T08:30:00Z'));
  assert.equal(date, '20261110');
  assert.equal(minutes, 9 * 60 + 30); // Europe/Rome è UTC+1 a novembre
});

test('parseStopsCsv: legge le fermate, gestisce le virgolette, scarta le stazioni', () => {
  const stops = parseStopsCsv(STOPS_CSV);
  assert.equal(stops.length, 4);
  assert.equal(stops[0].name, 'TERMINI (MA-MB-FS)');
  assert.equal(stops[2].name, 'FERMATA "QUOTATA"');
  assert.ok(!stops.some((s) => s.id === '05003'), 'location_type 1 non è una fermata');
  assert.ok(stops.some((s) => s.id === '05004'), 'location_type 0 esplicito è una fermata');
  assert.equal(stops[1].lat, 41.823818);
});

test('readCsvRows: legge il CSV a blocchi, anche con righe spezzate', async () => {
  const chunks = ['stop_id,stop_name\r\n1,"Prima', ' fermata"\r\n2,Seconda\r\n'];
  const rows = [];
  for await (const row of readCsvRows(Readable.from(chunks))) rows.push(row);
  assert.deepEqual(rows, [
    { stop_id: '1', stop_name: 'Prima fermata' },
    { stop_id: '2', stop_name: 'Seconda' },
  ]);
});

test('StopIndex: trova le fermate nel raggio, ordinate per distanza', () => {
  const index = new StopIndex(parseStopsCsv(STOPS_CSV));
  const nearby = index.nearby({ lat: 41.9013, lon: 12.5004 }, 500);
  assert.equal(nearby.length, 2);
  assert.equal(nearby[0].id, '05000');
  assert.ok(nearby[0].distance < nearby[1].distance);
  assert.equal(index.byId.get('05001').name, 'NERVI/PALAZZO SPORT');
});

test('StopIndex: rispetta il raggio e il limite', () => {
  const index = new StopIndex(parseStopsCsv(STOPS_CSV));
  assert.equal(index.nearby({ lat: 41.9013, lon: 12.5004 }, 50).length, 1);
  assert.equal(index.nearby({ lat: 41.9013, lon: 12.5004 }, 500, { limit: 1 }).length, 1);
  assert.equal(index.nearby({ lat: 41.0, lon: 12.0 }, 500).length, 0);
});

test('buildDepartures: tiene solo i passaggi futuri e li raggruppa per linea', () => {
  const scheduled = [
    { stopId: 'A', routeId: '105', line: '105', headsign: 'Venezia', minutes: 600 },
    { stopId: 'A', routeId: '105', line: '105', headsign: 'Venezia', minutes: 612 },
    { stopId: 'A', routeId: '105', line: '105', headsign: 'Venezia', minutes: 590 },
    { stopId: 'A', routeId: '62', line: '62', headsign: 'Stazione', minutes: 604 },
    { stopId: 'B', routeId: '105', line: '105', headsign: 'Venezia', minutes: 700 },
  ];

  const result = buildDepartures(scheduled, { nowMinutes: 600 });
  const stopA = result.get('A');
  assert.equal(stopA.length, 2, 'una voce per linea');

  const l105 = stopA.find((d) => d.routeId === '105');
  assert.equal(l105.waitMinutes, 0, 'usa il primo passaggio utile (600)');
  const l62 = stopA.find((d) => d.routeId === '62');
  assert.equal(l62.waitMinutes, 4);

  assert.equal(result.get('B')[0].waitMinutes, 100);
});

test('buildDepartures: una linea con due direzioni mostra il passaggio più vicino', () => {
  const scheduled = [
    { stopId: 'A', routeId: 'H', line: 'H', headsign: 'TERMINI', minutes: 606 },
    { stopId: 'A', routeId: 'H', line: 'H', headsign: 'DEI CAPASSO', minutes: 609 },
    { stopId: 'A', routeId: 'H', line: 'H', headsign: 'TERMINI', minutes: 660 },
  ];
  const [h] = buildDepartures(scheduled, { nowMinutes: 600 }).get('A');
  assert.equal(h.waitMinutes, 6);
  assert.equal(h.headsign, 'TERMINI');
});

test('buildDepartures: scarta i passaggi troppo lontani nel tempo', () => {
  const scheduled = [
    { stopId: 'A', routeId: 'n8', line: 'n8', minutes: 600 + 744 },
    { stopId: 'A', routeId: '1', line: '1', minutes: 600 + 42 },
  ];
  const lines = buildDepartures(scheduled, { nowMinutes: 600 }).get('A');
  assert.deepEqual(lines.map((d) => d.routeId), ['1']);
});

test('buildDepartures: tolleranza sui passaggi appena passati', () => {
  const scheduled = [
    { stopId: 'A', routeId: '1', line: '1', minutes: 599 },
    { stopId: 'A', routeId: '2', line: '2', minutes: 595 },
  ];
  const result = buildDepartures(scheduled, { nowMinutes: 600, graceMinutes: 1 });
  assert.deepEqual(
    result.get('A').map((d) => d.routeId),
    ['1'],
  );
});

test('buildDepartures: scarta righe non valide e limita i risultati', () => {
  const scheduled = [
    null,
    { stopId: 'A' },
    { stopId: 'A', routeId: 'X', minutes: Number.NaN },
    ...Array.from({ length: 10 }, (_, i) => ({
      stopId: 'A',
      routeId: `R${i}`,
      line: `R${i}`,
      minutes: 601 + i,
    })),
  ];
  const result = buildDepartures(scheduled, { nowMinutes: 600, perStop: 4 });
  assert.equal(result.get('A').length, 4);
});

test('isAtacBusRoute: solo bus dell’agenzia ATAC', () => {
  assert.equal(isAtacBusRoute({ agencyId: 'OP1', type: '3' }), true);
  assert.equal(isAtacBusRoute({ agencyId: 'OP1', type: '0' }), false);
  assert.equal(isAtacBusRoute({ agencyId: 'TUS', type: '3' }), false);
  assert.equal(isAtacBusRoute(null), false);
});
