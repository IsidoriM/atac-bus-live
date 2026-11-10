/* global L */

const REFRESH_MS = 30_000;

const state = {
  vehicles: [],
  routes: [],
  routeById: new Map(),
  selectedRouteId: null,
  selectedVehicleId: null,
  query: '',
  onlyMoving: false,
  tab: 'vehicles',
  dataAt: null,
  stale: false,
  hasData: false,
  fetching: false,
  nextRefreshAt: 0,
  shapes: new Map(),
  shapesVisible: true,
};

const $ = (id) => document.getElementById(id);

const el = {
  livePill: $('livePill'),
  liveText: $('liveText'),
  statBuses: $('statBuses'),
  statLines: $('statLines'),
  statMoving: $('statMoving'),
  updatedAt: $('updatedAt'),
  refreshBtn: $('refreshBtn'),
  tabVehicleCount: $('tabVehicleCount'),
  tabLineCount: $('tabLineCount'),
  search: $('searchInput'),
  clearSearch: $('clearSearch'),
  onlyMoving: $('onlyMoving'),
  selectionBanner: $('selectionBanner'),
  selLine: $('selLine'),
  selTitle: $('selTitle'),
  selSub: $('selSub'),
  clearSelection: $('clearSelection'),
  listTitle: $('listTitle'),
  listCount: $('listCount'),
  list: $('list'),
  footCount: $('footCount'),
  fitBtn: $('fitBtn'),
  toggleShape: $('toggleShape'),
  toggleShapeText: $('toggleShapeText'),
  mapStatus: $('mapStatus'),
  loading: $('loading'),
  toast: $('toast'),
};

/* ---------- utils ---------- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

function lineColor(line) {
  let hash = 0;
  for (const ch of String(line)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${hash} 78% 58%)`;
}

function chipStyle(line) {
  return `--c:${lineColor(line)}`;
}

function timeRome(date = new Date()) {
  return new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Rome',
  }).format(date);
}

function timeAgo(unixSeconds) {
  if (!unixSeconds) return '—';
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (seconds < 15) return 'adesso';
  if (seconds < 60) return `${seconds} s fa`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min fa`;
  return `${Math.floor(minutes / 60)} h fa`;
}

function splitQuery(query) {
  return normalize(query).split(/\s+/).filter(Boolean);
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function matchesQuery(parts, tokens) {
  if (!tokens.length) return true;
  const haystack = normalize(parts.join(' '));
  return tokens.every((token) => haystack.includes(token));
}

function relevanceRank(value, tokens) {
  if (tokens.length !== 1) return 2;
  const normalized = normalize(value);
  if (normalized === tokens[0]) return 0;
  if (normalized.startsWith(tokens[0])) return 1;
  return 2;
}

function compareLines(a, b) {
  return a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' });
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 6000);
}

/* ---------- map ---------- */

let map = null;
let markers = new Map();
let markerLayer = null;
let shapeLayer = null;

function initMap() {
  markerLayer = L.layerGroup();
  shapeLayer = L.layerGroup();

  map = L.map('map', {
    zoomControl: false,
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 18,
    attributionControl: true,
  }).setView([41.9, 12.51], 12);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  markerLayer.addTo(map);
  shapeLayer.addTo(map);

  map.on('popupopen', (event) => {
    const button = event.popup.getElement()?.querySelector('[data-filter-route]');
    if (!button) return;
    button.addEventListener('click', () => {
      map.closePopup();
      selectRoute(button.dataset.filterRoute);
    });
  });
}

function popupHtml(v) {
  const speed = v.speedKmh === null ? 'n.d.' : `${v.speedKmh} km/h`;
  return `
    <div class="popup">
      <div class="popup-head">
        <span class="line-chip" style="${chipStyle(v.line)}">${esc(v.line)}</span>
        <span class="popup-dest">${esc(v.headsign || 'Destinazione n.d.')}</span>
      </div>
      <div class="popup-grid">
        <div class="popup-cell"><span>Vettura</span><strong>${esc(v.label)}</strong></div>
        <div class="popup-cell"><span>Velocità</span><strong>${speed}</strong></div>
        <div class="popup-cell"><span>Stato</span><strong>${esc(v.status)}</strong></div>
        <div class="popup-cell"><span>Occupazione</span><strong>${esc(v.occupancy || 'n.d.')}</strong></div>
        <div class="popup-cell"><span>Aggiornato</span><strong>${timeAgo(v.timestamp)}</strong></div>
        <div class="popup-cell"><span>Direzione</span><strong>${v.direction === 1 ? 'Ritorno' : 'Andata'}</strong></div>
      </div>
      <button class="popup-btn" type="button" data-filter-route="${esc(v.routeId)}">
        Mostra solo la linea ${esc(v.line)}
      </button>
    </div>`;
}

function applyMarkerStyle(marker, v) {
  const selected = state.selectedRouteId === v.routeId;
  const dimmed = Boolean(state.selectedRouteId) && !selected;
  marker.setStyle({
    radius: dimmed ? 3.6 : selected ? 6.8 : 5.5,
    fillColor: lineColor(v.line),
    fillOpacity: dimmed ? 0.22 : 1,
    opacity: dimmed ? 0.35 : 0.9,
    weight: selected ? 1.6 : 1.1,
  });
}

function markerFor(v) {
  const marker = L.circleMarker([v.lat, v.lon], {
    radius: 5.5,
    color: 'rgba(255,255,255,0.88)',
    weight: 1.1,
    opacity: 0.9,
    fillColor: lineColor(v.line),
    fillOpacity: 1,
  });

  applyMarkerStyle(marker, v);
  marker.bindTooltip(`${esc(v.line)} → ${esc(v.headsign || '')}`, {
    className: 'bus-tooltip',
    direction: 'top',
    offset: [0, -7],
    opacity: 1,
  });
  marker.bindPopup(() => popupHtml(v), { maxWidth: 260, minWidth: 240 });
  marker.on('click', () => {
    state.selectedVehicleId = v.id;
    highlightVehicleRow();
  });

  markerLayer.addLayer(marker);
  markers.set(v.id, { marker, vehicle: v });
  return marker;
}

function isMarkerVisible(v) {
  if (state.onlyMoving && v.status !== 'In transito') return false;
  return true;
}

function renderMarkers() {
  const seen = new Set();

  for (const v of state.vehicles) {
    if (!isMarkerVisible(v)) continue;
    seen.add(v.id);
    const entry = markers.get(v.id);
    if (!entry) {
      markerFor(v);
      continue;
    }

    entry.vehicle = v;
    entry.marker.setLatLng([v.lat, v.lon]);
    entry.marker.setTooltipContent(`${esc(v.line)} → ${esc(v.headsign || '')}`);
    if (entry.marker.isPopupOpen()) entry.marker.setPopupContent(popupHtml(v));
    applyMarkerStyle(entry.marker, v);
  }

  for (const [id, entry] of markers) {
    if (seen.has(id)) continue;
    markerLayer.removeLayer(entry.marker);
    markers.delete(id);
  }
}

function fitAll() {
  if (!markers.size) return;
  const bounds = L.latLngBounds([...markers.values()].map((m) => m.marker.getLatLng()));
  map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
}

function fitShape(routeId) {
  const data = state.shapes.get(routeId);
  if (!data?.segments?.length) return false;
  const points = data.segments.flatMap((segment) => segment.points);
  if (!points.length) return false;
  map.fitBounds(L.latLngBounds(points), { padding: [56, 56], maxZoom: 15 });
  return true;
}

/* ---------- route shapes ---------- */

async function fetchShape(routeId) {
  if (state.shapes.has(routeId)) return state.shapes.get(routeId);
  const res = await fetch(`/api/routes/${encodeURIComponent(routeId)}/shape`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.shapes.set(routeId, data);
  return data;
}

function drawShape() {
  shapeLayer.clearLayers();
  if (!state.shapeVisible || !state.selectedRouteId) return;

  const data = state.shapes.get(state.selectedRouteId);
  if (!data) return;

  const color = lineColor(data.name);
  for (const segment of data.segments) {
    L.polyline(segment.points, {
      color,
      weight: 11,
      opacity: 0.12,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(shapeLayer);

    L.polyline(segment.points, {
      color,
      weight: 3,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: segment.direction === 0 ? null : '7 8',
      interactive: false,
    }).addTo(shapeLayer);
  }
}

/* ---------- selection ---------- */

async function selectRoute(routeId, { fit = true } = {}) {
  if (!routeId || state.selectedRouteId === routeId) {
    if (routeId) {
      state.tab = 'vehicles';
      syncTabs();
      renderSelection();
      renderList();
    }
    return;
  }

  state.selectedRouteId = routeId;
  state.selectedVehicleId = null;
  state.tab = 'vehicles';
  syncTabs();
  renderSelection();
  renderList();
  renderMarkers();

  el.toggleShape.hidden = false;
  el.toggleShapeText.textContent = state.shapesVisible ? 'Nascondi percorso' : 'Mostra percorso';

  try {
    await fetchShape(routeId);
    drawShape();
    if (fit) fitShape(routeId);
  } catch {
    showToast('Tracciato della linea non disponibile.');
  }
}

function clearRouteSelection() {
  state.selectedRouteId = null;
  state.selectedVehicleId = null;
  shapeLayer.clearLayers();
  el.toggleShape.hidden = true;
  renderSelection();
  renderList();
  renderMarkers();
}

function renderSelection() {
  const route = state.selectedRouteId ? state.routeById.get(state.selectedRouteId) : null;
  if (!route) {
    el.selectionBanner.hidden = true;
    el.listTitle.textContent = 'Tutti gli autobus';
    return;
  }

  el.selectionBanner.hidden = false;
  el.selLine.textContent = route.name;
  el.selLine.style.cssText = chipStyle(route.name);
  el.selTitle.textContent = `Linea ${route.name}`;
  el.selSub.textContent = route.headsigns.filter(Boolean).join(' ↔ ') || 'Linea ATAC';
  el.listTitle.textContent = `Linea ${route.name}`;
}

function highlightVehicleRow() {
  const rows = el.list.querySelectorAll('.bus-row');
  for (const row of rows) {
    row.classList.toggle('is-selected', row.dataset.vehicle === state.selectedVehicleId);
  }
}

function focusVehicle(vehicleId) {
  const entry = markers.get(vehicleId);
  const vehicle = state.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) return;
  state.selectedVehicleId = vehicleId;
  highlightVehicleRow();

  if (!entry) {
    showToast('Questo bus non è visibile con i filtri attuali.');
    return;
  }

  map.flyTo(entry.marker.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.7 });
  window.setTimeout(() => entry.marker.openPopup(), 350);
}

/* ---------- rendering ---------- */

function syncTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}

function renderStats() {
  const stats = state.hasData
    ? {
        total: state.vehicles.length,
        lines: new Set(state.vehicles.map((v) => v.routeId)).size,
        moving: state.vehicles.filter((v) => v.status === 'In transito').length,
      }
    : { total: 0, lines: 0, moving: 0 };

  el.statBuses.textContent = state.hasData ? stats.total.toLocaleString('it-IT') : '–';
  el.statLines.textContent = state.hasData ? stats.lines.toLocaleString('it-IT') : '–';
  el.statMoving.textContent = state.hasData ? stats.moving.toLocaleString('it-IT') : '–';
  el.tabVehicleCount.textContent = stats.total.toLocaleString('it-IT');
  const shownLines = state.routes.length
    ? state.routes.filter((r) => r.active > 0).length
    : state.hasData
      ? stats.lines
      : 0;
  el.tabLineCount.textContent = shownLines.toLocaleString('it-IT');
  el.footCount.textContent = state.hasData ? 'aggiornamento · 30 s' : '';
}

function renderList() {
  const tokens = splitQuery(state.query);

  if (state.tab === 'lines') {
    renderLineList(tokens);
    return;
  }

  const filtered = state.vehicles.filter((v) => {
    if (state.selectedRouteId && v.routeId !== state.selectedRouteId) return false;
    if (state.onlyMoving && v.status !== 'In transito') return false;
    return matchesQuery([v.line, v.label, v.headsign, v.status], tokens);
  });

  if (tokens.length) {
    filtered.sort(
      (a, b) =>
        relevanceRank(a.line, tokens) - relevanceRank(b.line, tokens) ||
        compareLines(a.line, b.line),
    );
  }

  el.listCount.textContent = filtered.length.toLocaleString('it-IT');
  el.listTitle.textContent = state.selectedRouteId
    ? `Linea ${state.routeById.get(state.selectedRouteId)?.name || state.selectedRouteId}`
    : 'Tutti gli autobus';

  if (!filtered.length) {
    el.list.innerHTML = emptyState(
      state.hasData
        ? 'Nessun autobus trovato'
        : 'In attesa dei dati',
      state.hasData
        ? 'Prova a cambiare ricerca o a rimuovere i filtri.'
        : 'Connessione ai dati in tempo reale di Roma Mobilità…',
    );
    return;
  }

  const rows = filtered.map((v) => {
    const moving = v.status === 'In transito';
    const speed = v.speedKmh === null ? '' : `${v.speedKmh} km/h`;
    const selected = v.id === state.selectedVehicleId;
    return `
      <button class="bus-row${selected ? ' is-selected' : ''}" type="button" role="listitem"
        data-vehicle="${esc(v.id)}" title="Vettura ${esc(v.label)} · ${esc(v.line)}">
        <span class="line-chip" style="${chipStyle(v.line)}">${esc(v.line)}</span>
        <span class="bus-main">
          <span class="bus-dest">${esc(v.headsign || 'Destinazione n.d.')}</span>
          <span class="bus-meta">
            <span>vettura ${esc(v.label)}</span>
            <span class="dot-sep"></span>
            <span>${esc(timeAgo(v.timestamp))}</span>
          </span>
        </span>
        <span class="bus-side">
          <span class="bus-speed">${esc(speed)}</span>
          <span class="bus-state" data-moving="${moving}">${esc(v.status)}</span>
        </span>
      </button>`;
  });

  el.list.innerHTML = rows.join('');
}

function renderLineList(tokens) {
  const routes = state.routes
    .filter((r) => matchesQuery([r.name, ...r.headsigns], tokens))
    .sort((a, b) => {
      if (tokens.length) {
        const byRelevance = relevanceRank(a.name, tokens) - relevanceRank(b.name, tokens);
        if (byRelevance !== 0) return byRelevance;
      }
      if (b.active !== a.active) return b.active - a.active;
      return compareLines(a.name, b.name);
    });

  el.listCount.textContent = routes.length.toLocaleString('it-IT');
  el.listTitle.textContent = 'Linee ATAC';

  if (!routes.length) {
    el.list.innerHTML = emptyState(
      'Nessuna linea trovata',
      'Controlla il nome della linea o cancella la ricerca.',
    );
    return;
  }

  const rows = routes.map((route) => {
    const dests = route.headsigns.filter(Boolean);
    const sub = dests.length ? dests.join(' ↔ ') : `${route.tripCount} corse programmate`;
    return `
      <button class="line-row${route.id === state.selectedRouteId ? ' is-selected' : ''}" type="button"
        data-route="${esc(route.id)}">
        <span class="line-chip" style="${chipStyle(route.name)}">${esc(route.name)}</span>
        <span class="line-main">
          <span class="line-dest">${esc(dests[0] || 'Linea ATAC')}</span>
          <span class="line-sub">${esc(sub)} · ${route.tripCount} corse</span>
        </span>
        <span class="line-active${route.active ? '' : ' is-zero'}">
          <span class="bus-mini"></span>${route.active}
        </span>
      </button>`;
  });

  el.list.innerHTML = rows.join('');
}

function emptyState(title, message) {
  return `
    <div class="empty">
      <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
        <path d="M5 17h14M7 17V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v10M9 17v3M15 17v3M7 9h10"
          fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        <circle cx="9" cy="14" r=".8" fill="currentColor"/>
        <circle cx="15" cy="14" r=".8" fill="currentColor"/>
      </svg>
      <strong>${esc(title)}</strong>
      <span>${esc(message)}</span>
    </div>`;
}

/* ---------- data ---------- */

function setLive(stateName, text) {
  el.livePill.dataset.state = stateName;
  el.liveText.textContent = text;
}

async function loadRoutes() {
  try {
    const res = await fetch('/api/routes', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.routes = data.routes || [];
    state.routeById = new Map(state.routes.map((r) => [r.id, r]));
    if (state.tab === 'lines') renderList();
    renderStats();
  } catch {
    /* l'elenco linee non è indispensabile per la mappa */
  }
}

async function loadData({ manual = false } = {}) {
  if (state.fetching) return;
  state.fetching = true;
  if (manual) el.refreshBtn.classList.add('is-spinning');

  try {
    const res = await fetch(`/api/vehicles${manual ? '?force=1' : ''}`, {
      cache: 'no-store',
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.detail || payload.error || `HTTP ${res.status}`);
    }
    const data = await res.json();

    state.vehicles = data.vehicles || [];
    state.dataAt = new Date();
    state.hasData = true;
    state.stale = Boolean(data.stale);

    if (state.stale) {
      setLive('stale', 'Dati non aggiornati');
      showToast('Il feed di Roma Mobilità non risponde: mostro l’ultima rilevazione disponibile.');
    } else {
      setLive('live', 'In diretta');
    }

    const routesById = new Map(state.routes.map((r) => [r.id, r]));
    const counts = new Map();
    for (const v of state.vehicles) counts.set(v.routeId, (counts.get(v.routeId) || 0) + 1);
    for (const route of state.routes) route.active = counts.get(route.id) || 0;
    state.routeById = routesById;

    el.updatedAt.textContent = `Aggiornato ${timeRome()}`;
    el.loading.classList.add('is-hidden');

    renderStats();
    renderSelection();
    renderMarkers();
    renderList();

    if (state.selectedRouteId && !state.shapes.has(state.selectedRouteId)) {
      fetchShape(state.selectedRouteId).then(() => {
        drawShape();
      }).catch(() => {});
    }
  } catch (err) {
    if (!state.hasData) {
      setLive('error', 'Offline');
      el.loading.classList.add('is-hidden');
      el.list.innerHTML = emptyState(
        'Dati non disponibili',
        'Non riesco a contattare il feed di Roma Mobilità. Riprova tra poco.',
      );
      el.listCount.textContent = '0';
    } else {
      setLive('stale', 'Aggiornamento fallito');
      showToast(`Aggiornamento non riuscito: ${err.message}`);
    }
  } finally {
    state.fetching = false;
    el.refreshBtn.classList.remove('is-spinning');
    state.nextRefreshAt = Date.now() + REFRESH_MS;
    tick();
  }
}

function tick() {
  if (!state.dataAt) {
    if (boot.done && Date.now() >= state.nextRefreshAt && !state.fetching) loadData();
    return;
  }
  const left = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  const time = timeRome(state.dataAt);
  const staleNote = state.stale ? ' · dati non aggiornati' : '';
  el.mapStatus.innerHTML = `Aggiornato <strong>${time}</strong>${staleNote} · tra ${left}s`;

  if (left <= 0 && !state.fetching && !document.hidden) loadData();
}

/* ---------- events ---------- */

function bindEvents() {
  el.refreshBtn.addEventListener('click', () => loadData({ manual: true }));

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      syncTabs();
      renderList();
    });
  });

  let searchTimer = null;
  el.search.addEventListener('input', () => {
    state.query = el.search.value;
    el.clearSearch.hidden = !state.query;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 90);
  });

  el.clearSearch.addEventListener('click', () => {
    state.query = '';
    el.search.value = '';
    el.clearSearch.hidden = true;
    renderList();
    el.search.focus();
  });

  el.onlyMoving.addEventListener('change', () => {
    state.onlyMoving = el.onlyMoving.checked;
    renderList();
    renderMarkers();
  });

  el.list.addEventListener('click', (event) => {
    const busRow = event.target.closest('[data-vehicle]');
    if (busRow) {
      focusVehicle(busRow.dataset.vehicle);
      return;
    }
    const lineRow = event.target.closest('[data-route]');
    if (lineRow) selectRoute(lineRow.dataset.route);
  });

  el.clearSelection.addEventListener('click', clearRouteSelection);
  el.fitBtn.addEventListener('click', fitAll);
  el.toggleShape.addEventListener('click', () => {
    state.shapesVisible = !state.shapesVisible;
    el.toggleShapeText.textContent = state.shapesVisible ? 'Nascondi percorso' : 'Mostra percorso';
    drawShape();
  });

  window.addEventListener('resize', () => map.invalidateSize());
}

/* ---------- boot ---------- */

async function boot() {
  if (typeof L === 'undefined') {
    el.loading.innerHTML =
      '<p>Mappa non disponibile</p><small>Impossibile caricare Leaflet dalla CDN. Verifica la connessione.</small>';
    el.loading.classList.remove('is-hidden');
    return;
  }

  initMap();
  bindEvents();
  syncTabs();
  setInterval(tick, 1000);
  tick();

  await Promise.all([loadData(), loadRoutes()]);
  state.nextRefreshAt = Date.now() + REFRESH_MS;
  boot.done = true;

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() >= state.nextRefreshAt) loadData();
  });
}

boot();
