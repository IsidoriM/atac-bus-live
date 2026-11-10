import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { loadGtfsData } from './src/gtfs.js';
import { fetchSnapshot } from './src/realtime.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SNAPSHOT_TTL_MS = 20_000;

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h', index: false }));

let staticData = null;
let cache = { data: null, at: 0 };
let inflight = null;

async function getSnapshot(force = false) {
  if (!force && cache.data && Date.now() - cache.at < SNAPSHOT_TTL_MS) {
    return cache.data;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const data = await fetchSnapshot(staticData);
      cache = { data, at: Date.now() };
      return data;
    } catch (err) {
      if (cache.data) {
        return {
          ...cache.data,
          stale: true,
          error: err.message,
        };
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

app.get('/api/vehicles', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const snapshot = await getSnapshot(req.query.force === '1');
    res.json(snapshot);
  } catch (err) {
    res.status(502).json({
      error: 'Impossibile leggere i dati in tempo reale di Roma Mobilità.',
      detail: err.message,
    });
  }
});

app.get('/api/routes', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const counts = new Map();
  try {
    const snapshot = await getSnapshot();
    for (const v of snapshot.vehicles) {
      counts.set(v.routeId, (counts.get(v.routeId) || 0) + 1);
    }
  } catch {
    /* senza feed restituiamo comunque l'elenco delle linee */
  }

  res.json({
    updatedAt: cache.data?.generatedAt || null,
    routes: staticData.routes.map((route) => ({
      id: route.id,
      name: route.name,
      headsigns: route.headsigns,
      tripCount: route.tripCount,
      active: counts.get(route.id) || 0,
    })),
  });
});

app.get('/api/routes/:routeId/shape', (req, res) => {
  const route = staticData.routeById.get(req.params.routeId);
  if (!route) {
    res.status(404).json({ error: 'Linea non trovata' });
    return;
  }

  const segments = [];
  route.shapeIds.forEach((shapeId, direction) => {
    if (!shapeId) return;
    const points = staticData.shapes.get(shapeId);
    if (!points || points.length < 2) return;
    segments.push({
      direction,
      headsign: route.headsigns[direction] || route.headsigns[0] || '',
      points,
    });
  });

  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ routeId: route.id, name: route.name, segments });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    routes: staticData.routes.length,
    lastSnapshot: cache.data?.generatedAt || null,
    stale: Boolean(cache.data?.stale),
  });
});

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Endpoint non trovato' });
    return;
  }
  res.status(404).send('Not found');
});

let server = null;

async function main() {
  staticData = await loadGtfsData();
  console.log('[server] dati statici pronti');
  server = app.listen(PORT, () => {
    console.log(`\n  ATAC Bus Live -> http://localhost:${PORT}\n`);
  });
}

main().catch((err) => {
  console.error('[server] avvio impossibile:', err.message);
  process.exit(1);
});

function shutdown() {
  if (!server) process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
