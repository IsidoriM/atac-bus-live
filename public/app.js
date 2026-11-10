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
  location: null,
  gps: null,
  gpsState: 'idle',
  stops: [],
  stopsAt: null,
  stopsRadius: 500,
  stopsLoading: false,
  stopsError: null,
  stopsSchedule: null,
  selectedStopId: null,
  stopMarkers: new Map(),
  mapStyle: 'voyager',
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
  tabStopCount: $('tabStopCount'),
  search: $('searchInput'),
  clearSearch: $('clearSearch'),
  locationField: $('locationField'),
  locationInput: $('locationInput'),
  locationSuggestions: $('locationSuggestions'),
  locateBtn: $('locateBtn'),
  clearLocation: $('clearLocation'),
  currentPositionField: $('currentPositionField'),
  currentPositionValue: $('currentPositionValue'),
  currentPositionBtn: $('currentPositionBtn'),
  currentPositionBadge: $('currentPositionBadge'),
  currentPositionCoords: $('currentPositionCoords'),
  currentPositionPlace: $('currentPositionPlace'),
  currentPositionPlaceName: $('currentPositionPlaceName'),
  currentPositionPlaceDetail: $('currentPositionPlaceDetail'),
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
  nearbyBtn: $('nearbyBtn'),
  mapStyle: document.querySelector('.map-style'),
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

const MAP_STYLE_KEY = 'atac-bus-live.map-style';

const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

/**
 * Stili della mappa. `voyager` è la mappa stradale chiara (simile a Google
 * Maps), `satellite` usa le foto aeree Esri, `dark` è la mappa notturna.
 */
const MAP_STYLES = {
  voyager: {
    label: 'Stradale',
    layers: [
      {
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        options: {
          subdomains: 'abcd',
          maxZoom: 20,
          attribution: `${MAP_ATTRIBUTION} &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>`,
        },
      },
    ],
  },
  satellite: {
    label: 'Satellite',
    layers: [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        options: {
          maxZoom: 19,
          attribution: `Foto aeree &copy; <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a>, Maxar, Earthstar Geographics · ${MAP_ATTRIBUTION}`,
        },
      },
      {
        // Etichette e nomi delle strade sopra le foto aeree.
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
        options: {
          subdomains: 'abcd',
          maxZoom: 20,
          attribution: '&copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>',
        },
      },
    ],
  },
  dark: {
    label: 'Scura',
    layers: [
      {
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        options: {
          subdomains: 'abcd',
          maxZoom: 20,
          attribution: `${MAP_ATTRIBUTION} &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>`,
        },
      },
    ],
  },
};

let tileLayers = [];

function loadSavedMapStyle() {
  let saved = null;
  try {
    saved = localStorage.getItem(MAP_STYLE_KEY);
  } catch {
    saved = null;
  }
  state.mapStyle = saved && MAP_STYLES[saved] ? saved : 'voyager';
}

function saveMapStyle(style) {
  try {
    localStorage.setItem(MAP_STYLE_KEY, style);
  } catch {
    /* storage non disponibile */
  }
}

/** Sostituisce i tile della mappa con quelli dello stile richiesto. */
function applyMapStyle(style, { save = true } = {}) {
  const config = MAP_STYLES[style] ? style : 'voyager';
  state.mapStyle = config;
  if (save) saveMapStyle(config);
  if (!map) return;

  for (const layer of tileLayers) layer.remove();
  tileLayers = MAP_STYLES[config].layers.map(({ url, options }) =>
    L.tileLayer(url, { ...options, detectRetina: false }).addTo(map),
  );

  // I tile nuovi vanno sotto marker e tracciati.
  for (const layer of tileLayers) layer.bringToBack();

  document.documentElement.dataset.mapStyle = config;
  document.querySelectorAll('.map-style-btn').forEach((button) => {
    const active = button.dataset.style === config;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function initMap() {
  markerLayer = L.layerGroup();
  shapeLayer = L.layerGroup();

  map = L.map('map', {
    zoomControl: false,
    preferCanvas: true,
    minZoom: 10,
    maxZoom: 20,
    attributionControl: true,
  }).setView([41.9, 12.51], 12);

  loadSavedMapStyle();
  applyMapStyle(state.mapStyle, { save: false });

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

/* ---------- location search ---------- */

const GEOCODE_ENDPOINT = 'https://photon.komoot.io/api/';
const ROME_CENTER = { lat: 41.9028, lon: 12.4964 };
const ROME_BBOX = '11.9,41.6,12.9,42.1';
const LOCATION_STORAGE_KEY = 'atac-bus-live.location';

let locationMarker = null;
let suggestionTimer = null;
let suggestionController = null;
let suggestions = [];
let activeSuggestion = -1;

function haversine(a, b) {
  const radius = 6_371_000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

function formatWait(minutes) {
  if (!Number.isFinite(minutes)) return '';
  if (minutes <= 0) return 'in arrivo';
  if (minutes === 1) return '1 min';
  return `${minutes} min`;
}

function placeFromFeature(feature) {
  const p = feature?.properties || {};
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  const lat = Number(coords[1]);
  const lon = Number(coords[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const title = [p.name, p.housenumber].filter(Boolean).join(' ') || street || p.city || 'Luogo';
  const detailParts = [];
  if (street && street !== title) detailParts.push(street);
  if (p.city && p.city !== title) detailParts.push(p.city);
  if (p.postcode) detailParts.push(p.postcode);

  return {
    lat,
    lon,
    title,
    street: p.street || (p.osm_key === 'highway' ? p.name : '') || '',
    detail: detailParts.join(' · '),
    label: [title, p.city && p.city !== title ? p.city : ''].filter(Boolean).join(', '),
  };
}

function closeSuggestions() {
  el.locationSuggestions.hidden = true;
  el.locationInput.setAttribute('aria-expanded', 'false');
  el.locationInput.removeAttribute('aria-activedescendant');
  activeSuggestion = -1;
}

function renderSuggestions() {
  if (!suggestions.length) {
    el.locationSuggestions.innerHTML = '<div class="location-empty">Nessun risultato</div>';
  } else {
    el.locationSuggestions.innerHTML = suggestions
      .map(
        (place, index) => `
        <button class="location-suggestion${index === activeSuggestion ? ' is-active' : ''}" type="button"
          role="option" id="loc-opt-${index}" data-index="${index}"
          aria-selected="${index === activeSuggestion}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
            <circle cx="12" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span class="loc-main">
            <span class="loc-title">${esc(place.title)}</span>
            ${place.detail ? `<span class="loc-sub">${esc(place.detail)}</span>` : ''}
          </span>
        </button>`,
      )
      .join('');
  }

  el.locationSuggestions.hidden = false;
  el.locationInput.setAttribute('aria-expanded', 'true');
  if (activeSuggestion >= 0) {
    el.locationInput.setAttribute('aria-activedescendant', `loc-opt-${activeSuggestion}`);
  } else {
    el.locationInput.removeAttribute('aria-activedescendant');
  }
}

async function fetchSuggestions(query) {
  const term = query.trim();
  if (term.length < 3) {
    suggestions = [];
    closeSuggestions();
    return;
  }

  suggestionController?.abort();
  const controller = new AbortController();
  suggestionController = controller;

  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set('q', term);
  url.searchParams.set('limit', '7');
  url.searchParams.set('lat', String(ROME_CENTER.lat));
  url.searchParams.set('lon', String(ROME_CENTER.lon));
  url.searchParams.set('bbox', ROME_BBOX);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (controller.signal.aborted) return;

    suggestions = (data.features || []).map(placeFromFeature).filter(Boolean).slice(0, 7);
    activeSuggestion = -1;
    if (document.activeElement === el.locationInput) renderSuggestions();
    else closeSuggestions();
  } catch (err) {
    if (err.name === 'AbortError') return;
    suggestions = [];
    if (document.activeElement === el.locationInput) {
      el.locationSuggestions.innerHTML =
        '<div class="location-empty">Ricerca non disponibile, riprova tra poco</div>';
      el.locationSuggestions.hidden = false;
    }
  }
}

async function reverseGeocode(lat, lon) {
  const buildUrl = (streetOnly) => {
    const url = new URL('https://photon.komoot.io/reverse');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('limit', '1');
    if (streetOnly) url.searchParams.set('osm_tag', 'highway');
    return url;
  };

  for (const streetOnly of [true, false]) {
    try {
      const res = await fetch(buildUrl(streetOnly), { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const feature = (data.features || [])[0];
      const place = feature ? placeFromFeature(feature) : null;
      if (place) return { ...place, feature };
    } catch {
      /* riprova senza filtro oppure usa il fallback */
    }
  }

  return null;
}

/**
 * Trasforma una feature Photon in un indirizzo leggibile:
 * `{ name, detail }` — es. { name: 'Piazza dei Cinquecento', detail: 'Esquilino · Roma' }.
 */
function describePlace(feature) {
  if (!feature) return null;
  const p = feature.properties || {};
  // Prima la via (con il civico), poi eventuali luoghi notevoli, infine la località.
  // Su una via senza civico il nome OSM sta in `name`: in quel caso è la via.
  const isStreet = p.osm_key === 'highway' || p.type === 'street';
  const name =
    [p.street, p.housenumber].filter(Boolean).join(' ') ||
    (isStreet ? p.name : '') ||
    p.name ||
    p.locality ||
    p.city ||
    '';
  // Il campo `name` di Photon a volte contiene un nome interno: lo si usa solo
  // come dettaglio, mai come etichetta principale se c'è già la via.
  const detailName = p.name && p.name !== name ? p.name : '';
  const detailParts = [];
  if (detailName) detailParts.push(detailName);
  if (p.district && p.district !== name) detailParts.push(p.district);
  if (p.locality && p.locality !== name) detailParts.push(p.locality);
  if (p.city && p.city !== name) detailParts.push(p.city);
  if (!name && !detailParts.length) return null;
  return {
    name: name || detailParts[0],
    detail: detailParts.filter((part) => part !== name).join(' · '),
  };
}

/**
 * Aggiorna la casella "La tua posizione attuale".
 * `gpsState`: idle | locating | ready | denied | unavailable | timeout
 */
function renderCurrentPosition() {
  if (!el.currentPositionValue) return;

  const states = {
    idle: 'non rilevata',
    locating: 'rilevamento…',
    ready: 'rilevata',
    denied: 'permesso negato',
    unavailable: 'non disponibile',
    timeout: 'tempo scaduto',
  };

  el.currentPositionBadge.dataset.state = state.gpsState;
  el.currentPositionBadge.textContent = states[state.gpsState] || states.idle;

  const gps = state.gps;
  if (gps) {
    el.currentPositionValue.textContent =
      gps.label || `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;
    el.currentPositionField.classList.add('is-located');
    el.currentPositionCoords.textContent =
      `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` +
      (gps.accuracy ? ` · ±${Math.round(gps.accuracy)} m` : '') +
      (gps.at ? ` · ${timeRome(new Date(gps.at))}` : '');

    const placeTitle =
      gps.placeName && gps.placeName !== gps.label ? gps.placeName : '';
    if (placeTitle || gps.placeDetail) {
      el.currentPositionPlaceName.textContent = placeTitle || gps.label || '';
      el.currentPositionPlaceDetail.textContent = gps.placeDetail || '';
      el.currentPositionPlace.hidden = false;
    } else {
      el.currentPositionPlace.hidden = true;
    }
  } else {
    // Senza posizione non mostriamo nessun testo: restano solo il pulsante di
    // rilevamento e il badge di stato.
    el.currentPositionValue.textContent = '';
    el.currentPositionField.classList.remove('is-located');
    el.currentPositionCoords.textContent = '';
    el.currentPositionPlace.hidden = true;
  }

  el.currentPositionBtn.classList.toggle('is-loading', state.gpsState === 'locating');
}

/** Rileva la posizione del browser e la usa per l'app (bus e fermate vicine). */
function detectCurrentPosition({ silent = false } = {}) {
  if (!navigator.geolocation) {
    state.gpsState = 'unavailable';
    renderCurrentPosition();
    if (!silent) showToast('La geolocalizzazione non è supportata da questo browser.');
    return;
  }

  state.gpsState = 'locating';
  renderCurrentPosition();

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      state.gps = {
        lat: latitude,
        lon: longitude,
        accuracy: Number.isFinite(accuracy) ? accuracy : null,
        label: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
        at: Date.now(),
      };
      state.gpsState = 'ready';
      renderCurrentPosition();

      // La casella mostra subito le coordinate, poi la via esatta.
      setLocation({ lat: latitude, lon: longitude, label: state.gps.label });

      let place = null;
      try {
        place = await reverseGeocode(latitude, longitude);
      } catch {
        /* senza reverse geocoding restano le coordinate */
      }

      const described = describePlace(place?.feature) || null;
      if (described) {
        state.gps.placeName = described.name;
        state.gps.placeDetail = described.detail;
      }

      if (place?.street || place?.title) {
        const label = described?.name || place.street || place.title;
        state.gps.label = label;
        renderCurrentPosition();
        if (state.location) {
          state.location.label = label;
          el.locationInput.value = label;
          try {
            localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(state.location));
          } catch {
            /* storage non disponibile */
          }
        }
      }

      if (!silent) showToast(`Posizione attuale: ${state.gps.label}`);
    },
    (error) => {
      state.gpsState = error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable';
      renderCurrentPosition();
      if (silent) return;
      const messages = {
        1: 'Permesso di geolocalizzazione negato.',
        2: 'Posizione non disponibile.',
        3: 'Tempo scaduto durante il rilevamento della posizione.',
      };
      showToast(messages[error.code] || 'Impossibile rilevare la posizione attuale.');
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
  );
}

function renderLocationMarker() {
  if (!state.location) {
    if (locationMarker) {
      locationMarker.remove();
      locationMarker = null;
    }
    return;
  }

  const latlng = [state.location.lat, state.location.lon];
  if (!locationMarker) {
    locationMarker = L.circleMarker(latlng, {
      radius: 8,
      color: '#ffffff',
      weight: 2.5,
      opacity: 1,
      fillColor: '#3d8bff',
      fillOpacity: 1,
      className: 'user-location-marker',
    })
      .addTo(map)
      .bindTooltip('La tua posizione', {
        className: 'bus-tooltip',
        direction: 'top',
        offset: [0, -10],
        opacity: 1,
      });
  } else {
    locationMarker.setLatLng(latlng);
  }
  locationMarker.bringToFront();
}

function setLocation(place, { fly = true, save = true } = {}) {
  state.location = {
    lat: place.lat,
    lon: place.lon,
    label: place.label || place.title || 'Posizione',
  };

  el.locationInput.value = state.location.label;
  el.locationField.classList.add('is-located');
  el.clearLocation.hidden = false;
  el.locateBtn.classList.remove('is-loading');
  suggestions = [];
  closeSuggestions();
  renderLocationMarker();

  if (save) {
    try {
      localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(state.location));
    } catch {
      /* storage non disponibile */
    }
  }

  el.list.scrollTop = 0;
  invalidateStops();
  renderList();
  if (fly) map.flyTo([place.lat, place.lon], Math.max(map.getZoom(), 15), { duration: 0.9 });
}

/** La posizione è cambiata: le fermate vicine non valgono più. */
function invalidateStops() {
  state.stops = [];
  state.stopsAt = null;
  state.selectedStopId = null;
  state.stopsSchedule = null;
  state.stopsError = null;
  ensureStopLayer().clearLayers();
  state.stopMarkers = new Map();
  if (state.tab === 'stops') {
    loadNearbyStops({ silent: true });
  } else {
    renderStops();
  }
}

function applySavedLocation() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY) || 'null');
  } catch {
    saved = null;
  }

  if (
    !saved ||
    !Number.isFinite(Number(saved.lat)) ||
    !Number.isFinite(Number(saved.lon)) ||
    !saved.label
  ) {
    return;
  }

  setLocation(
    { lat: Number(saved.lat), lon: Number(saved.lon), label: saved.label },
    { fly: false, save: false },
  );
}

function clearLocation() {
  state.location = null;
  el.locationInput.value = '';
  el.locationField.classList.remove('is-located');
  el.clearLocation.hidden = true;
  el.locateBtn.classList.remove('is-loading');
  suggestions = [];
  closeSuggestions();
  renderLocationMarker();
  try {
    localStorage.removeItem(LOCATION_STORAGE_KEY);
  } catch {
    /* storage non disponibile */
  }
  invalidateStops();
  renderList();
}

function restoreLocationLabel(previous) {
  if (previous) {
    el.locationInput.value = previous.label;
    el.locationField.classList.add('is-located');
    el.clearLocation.hidden = false;
  } else {
    el.locationInput.value = '';
    el.locationField.classList.remove('is-located');
    el.clearLocation.hidden = true;
  }
}

function locateMe() {
  const previous = state.location ? { ...state.location } : null;

  // Aggiorna subito la casella al click; la posizione esatta arriva appena disponibile.
  clearTimeout(suggestionTimer);
  suggestions = [];
  closeSuggestions();
  el.locationInput.value = 'Posizione attuale…';
  el.locationField.classList.add('is-located');

  useCurrentPosition({ previous });
}

async function useCurrentPosition({ silent = false, previous = null } = {}) {
  if (!navigator.geolocation) {
    if (!silent) {
      restoreLocationLabel(previous);
      showToast('La geolocalizzazione non è supportata da questo browser.');
    }
    return;
  }

  el.locateBtn.classList.add('is-loading');
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      const coordsLabel = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

      // Mostra subito un valore nella casella, poi lo sostituisce con la via esatta.
      el.locationInput.value = coordsLabel;
      el.locationField.classList.add('is-located');
      el.clearLocation.hidden = false;

      let place = null;
      try {
        place = await reverseGeocode(latitude, longitude);
      } catch {
        /* senza reverse geocoding mostriamo comunque la posizione */
      }

      setLocation({
        lat: latitude,
        lon: longitude,
        label: place?.street || place?.title || coordsLabel,
      });

      if (!silent) {
        showToast(place?.street ? `Posizione impostata: ${place.street}` : 'Posizione attuale rilevata.');
      }
    },
    (error) => {
      el.locateBtn.classList.remove('is-loading');
      if (silent) return;
      restoreLocationLabel(previous);
      const messages = {
        1: 'Permesso di geolocalizzazione negato.',
        2: 'Posizione non disponibile.',
        3: 'Tempo scaduto durante il rilevamento della posizione.',
      };
      showToast(messages[error.code] || 'Impossibile rilevare la posizione attuale.');
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
  );
}

/* ---------- fermate vicine ---------- */

let stopLayer = null;
let nearbyController = null;

const NEARBY_RADIUS_KEY = 'atac-bus-live.nearby-radius';

function loadSavedRadius() {
  try {
    const saved = Number(localStorage.getItem(NEARBY_RADIUS_KEY));
    if (Number.isFinite(saved) && saved >= 100 && saved <= 2000) state.stopsRadius = saved;
  } catch {
    /* storage non disponibile */
  }
}

function saveRadius(value) {
  try {
    localStorage.setItem(NEARBY_RADIUS_KEY, String(value));
  } catch {
    /* storage non disponibile */
  }
}

function ensureStopLayer() {
  if (stopLayer) return stopLayer;
  stopLayer = L.layerGroup().addTo(map);
  return stopLayer;
}

function stopIcon(stop) {
  const selected = stop.id === state.selectedStopId;
  return L.divIcon({
    className: 'stop-marker-wrap',
    html: `<span class="stop-marker${selected ? ' is-selected' : ''}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function stopPopupHtml(stop) {
  const lines = stop.lines.length
    ? stop.lines
        .map(
          (l) => `
          <li class="stop-line">
            <span class="line-chip" style="${chipStyle(l.line)}">${esc(l.line)}</span>
            <span class="stop-line-main">
              <span class="stop-line-dest">${esc(l.headsign || 'Destinazione n.d.')}</span>
              <span class="stop-line-meta">
                ${l.activeBuses ? `${l.activeBuses} ${l.activeBuses === 1 ? 'bus in linea' : 'bus in linea'}` : 'nessun bus in linea'}
                ${l.nearestBusMeters !== null ? ` · più vicino ${esc(formatDistance(l.nearestBusMeters))}` : ''}
              </span>
            </span>
            <span class="stop-wait">${esc(formatWait(l.waitMinutes))}</span>
          </li>`,
        )
        .join('')
    : '<li class="stop-line stop-line-empty">Orari non disponibili per questa fermata</li>';

  return `
    <div class="popup">
      <div class="popup-head">
        <span class="popup-dest">${esc(stop.name)}</span>
      </div>
      <div class="popup-sub">${esc(formatDistance(stop.distance))} da te · fermata ${esc(stop.code || stop.id)}</div>
      <ul class="stop-lines">${lines}</ul>
      <button class="popup-btn" type="button" data-stop-focus="${esc(stop.id)}">
        Vedi tutti i passaggi
      </button>
    </div>`;
}

function renderStopMarkers() {
  const layer = ensureStopLayer();
  layer.clearLayers();
  state.stopMarkers = new Map();

  for (const stop of state.stops) {
    const marker = L.marker([stop.lat, stop.lon], {
      icon: stopIcon(stop),
      keyboard: false,
      title: stop.name,
    })
      .addTo(layer)
      .bindPopup(() => stopPopupHtml(stop), { maxWidth: 300, minWidth: 250 });

    marker.on('click', () => {
      state.selectedStopId = stop.id;
      renderStops();
      renderStopMarkers();
    });

    state.stopMarkers.set(stop.id, marker);
  }
}

async function loadNearbyStops({ silent = false } = {}) {
  if (!state.location) {
    if (!silent) showToast('Imposta prima la tua posizione o usa la geolocalizzazione.');
    return;
  }

  nearbyController?.abort();
  const controller = new AbortController();
  nearbyController = controller;

  state.stopsLoading = true;
  state.stopsError = null;
  renderStops();

  const url = new URL('/api/stops/nearby', window.location.origin);
  url.searchParams.set('lat', String(state.location.lat));
  url.searchParams.set('lon', String(state.location.lon));
  url.searchParams.set('radius', String(state.stopsRadius));
  url.searchParams.set('limit', '8');

  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (controller.signal.aborted) return;

    state.stops = (data.stops || []).map((stop) => ({
      ...stop,
      lines: [...(stop.lines || [])].sort(
        (a, b) => a.waitMinutes - b.waitMinutes || compareLines(a.line, b.line),
      ),
    }));
    state.stopsAt = new Date();
    state.stopsSchedule = data.schedule || null;
    if (!state.stops.some((s) => s.id === state.selectedStopId)) state.selectedStopId = null;

    renderStops();
    renderStopMarkers();
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.stopsError = err.message;
    state.stops = [];
    ensureStopLayer().clearLayers();
    state.stopMarkers = new Map();
    renderStops();
  } finally {
    if (nearbyController === controller) nearbyController = null;
    state.stopsLoading = false;
    renderStops();
  }
}

function renderStops() {
  el.tabStopCount.textContent = state.stops.length.toLocaleString('it-IT');
  if (state.tab !== 'stops') return;

  el.listTitle.textContent = 'Fermate vicine';
  el.listCount.textContent = state.stops.length.toLocaleString('it-IT');

  if (!state.location) {
    el.list.innerHTML = emptyStopsState(
      'Imposta la tua posizione',
      'Cerca un indirizzo, tocca il mirino o trascina la mappa e premi «Fermate qui».',
      true,
    );
    return;
  }

  if (state.stopsLoading && !state.stops.length) {
    el.list.innerHTML = `
      <div class="list-loading">
        <span class="spinner" aria-hidden="true"></span>
        Cerco le fermate vicine…
      </div>`;
    return;
  }

  if (state.stopsError) {
    el.list.innerHTML = emptyStopsState('Ricerca non riuscita', state.stopsError);
    return;
  }

  if (!state.stops.length) {
    el.list.innerHTML = emptyStopsState(
      'Nessuna fermata vicina',
      `Non ci sono fermate ATAC entro ${formatDistance(state.stopsRadius)}. Allarga il raggio di ricerca.`,
    );
    return;
  }

  const scheduleNote = state.stopsSchedule?.ready
    ? `orari aggiornati ${state.stopsSchedule.updatedAt ? timeRome(new Date(state.stopsSchedule.updatedAt)) : ''}`
    : 'orari in caricamento…';

  const rows = state.stops.map((stop) => {
    const lines = stop.lines.length
      ? stop.lines
          .map(
            (l) => `
            <span class="stop-chip" title="${esc(l.headsign || '')}">
              <span class="line-chip" style="${chipStyle(l.line)}">${esc(l.line)}</span>
              <span class="stop-chip-wait">${esc(formatWait(l.waitMinutes))}</span>
              ${l.activeBuses ? '<span class="stop-chip-live" aria-label="bus in linea"></span>' : ''}
            </span>`,
          )
          .join('')
      : '<span class="stop-no-lines">orari non disponibili</span>';

    return `
      <button class="stop-row${stop.id === state.selectedStopId ? ' is-selected' : ''}" type="button"
        role="listitem" data-stop="${esc(stop.id)}" title="${esc(stop.name)}">
        <span class="stop-main">
          <span class="stop-name">${esc(stop.name)}</span>
          <span class="stop-meta">${esc(formatDistance(stop.distance))} · fermata ${esc(stop.code || stop.id)}</span>
          <span class="stop-chips">${lines}</span>
        </span>
        <span class="stop-arrow" aria-hidden="true">›</span>
      </button>`;
  });

  el.list.innerHTML = `
    <div class="stops-toolbar">
      <span class="stops-radius-label">Raggio</span>
      <select id="stopsRadius" class="stops-radius" aria-label="Raggio di ricerca">
        ${[250, 500, 1000, 2000]
          .map(
            (r) =>
              `<option value="${r}"${r === state.stopsRadius ? ' selected' : ''}>${formatDistance(r)}</option>`,
          )
          .join('')}
      </select>
      <button class="btn btn-small" id="stopsRefresh" type="button">Aggiorna</button>
    </div>
    <div class="stops-note">${esc(scheduleNote)}</div>
    ${rows.join('')}`;
}

function emptyStopsState(title, message, withButton = false) {
  return `
    <div class="empty">
      <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
        <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z"
          fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
        <circle cx="12" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/>
      </svg>
      <strong>${esc(title)}</strong>
      <span>${esc(message)}</span>
      ${withButton ? '<button class="btn btn-small" id="stopsLocate" type="button">Usa la mia posizione</button>' : ''}
    </div>`;
}

function focusStop(stopId) {
  const stop = state.stops.find((s) => s.id === stopId);
  if (!stop) return;
  state.selectedStopId = stopId;
  renderStops();
  renderStopMarkers();
  map.flyTo([stop.lat, stop.lon], Math.max(map.getZoom(), 16), { duration: 0.7 });
  const marker = state.stopMarkers.get(stopId);
  if (marker) window.setTimeout(() => marker.openPopup(), 400);
}

function openNearby() {
  state.tab = 'stops';
  syncTabs();
  renderStops();

  if (!state.location) {
    showToast('Cerca la tua posizione o tocca il mirino per vedere le fermate vicine.');
    el.locationInput.focus();
    return;
  }
  if (!state.stops.length && !state.stopsLoading) loadNearbyStops();
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

  if (el.nearbyBtn) {
    const active = state.tab === 'stops';
    el.nearbyBtn.classList.toggle('is-active', active);
    el.nearbyBtn.title = active
      ? 'Torna agli autobus'
      : 'Fermate vicine e prossimi passaggi';
  }
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

  if (state.tab === 'stops') {
    renderStops();
    return;
  }

  let filtered = state.vehicles.filter((v) => {
    if (state.selectedRouteId && v.routeId !== state.selectedRouteId) return false;
    if (state.onlyMoving && v.status !== 'In transito') return false;
    return matchesQuery([v.line, v.label, v.headsign, v.status], tokens);
  });

  if (state.location) {
    filtered = filtered.map((v) => ({ ...v, distance: haversine(state.location, v) }));
    filtered.sort((a, b) => {
      if (tokens.length) {
        const byRelevance = relevanceRank(a.line, tokens) - relevanceRank(b.line, tokens);
        if (byRelevance !== 0) return byRelevance;
      }
      return a.distance - b.distance;
    });
  } else if (tokens.length) {
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
            ${state.location ? `<span class="bus-distance">${esc(formatDistance(v.distance))}</span><span class="dot-sep"></span>` : ''}
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

  el.locationInput.addEventListener('input', () => {
    el.clearLocation.hidden = !el.locationInput.value;

    if (!el.locationInput.value.trim()) {
      if (state.location) clearLocation();
      else {
        suggestions = [];
        closeSuggestions();
      }
      return;
    }

    clearTimeout(suggestionTimer);
    suggestionTimer = setTimeout(() => fetchSuggestions(el.locationInput.value), 280);
  });

  el.locationInput.addEventListener('focus', () => {
    if (suggestions.length && el.locationInput.value.trim().length >= 3) renderSuggestions();
  });

  el.locationInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSuggestions();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!suggestions.length || el.locationSuggestions.hidden) return;
      event.preventDefault();
      if (event.key === 'ArrowDown') {
        activeSuggestion = (activeSuggestion + 1) % suggestions.length;
      } else {
        activeSuggestion = activeSuggestion <= 0 ? suggestions.length - 1 : activeSuggestion - 1;
      }
      renderSuggestions();
      el.locationSuggestions.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (event.key === 'Enter') {
      if (!suggestions.length || el.locationSuggestions.hidden) return;
      event.preventDefault();
      const place = suggestions[activeSuggestion >= 0 ? activeSuggestion : 0];
      if (place) setLocation(place);
    }
  });

  el.locationInput.addEventListener('blur', () => {
    window.setTimeout(closeSuggestions, 140);
  });

  el.locationSuggestions.addEventListener('pointerdown', (event) => event.preventDefault());

  el.locationSuggestions.addEventListener('click', (event) => {
    const option = event.target.closest('[data-index]');
    if (!option) return;
    const place = suggestions[Number(option.dataset.index)];
    if (place) setLocation(place);
  });

  el.locateBtn.addEventListener('click', locateMe);

  el.currentPositionBtn.addEventListener('click', () => detectCurrentPosition());
  el.currentPositionField.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    detectCurrentPosition();
  });
  el.clearLocation.addEventListener('click', () => {
    clearLocation();
    el.locationInput.focus();
  });

  el.onlyMoving.addEventListener('change', () => {
    state.onlyMoving = el.onlyMoving.checked;
    renderList();
    renderMarkers();
  });

  el.list.addEventListener('click', (event) => {
    if (event.target.closest('#stopsRefresh')) {
      loadNearbyStops();
      return;
    }
    if (event.target.closest('#stopsLocate')) {
      locateMe();
      return;
    }

    const busRow = event.target.closest('[data-vehicle]');
    if (busRow) {
      focusVehicle(busRow.dataset.vehicle);
      return;
    }
    const lineRow = event.target.closest('[data-route]');
    if (lineRow) {
      selectRoute(lineRow.dataset.route);
      return;
    }
    const stopRow = event.target.closest('[data-stop]');
    if (stopRow) focusStop(stopRow.dataset.stop);
  });

  el.mapStyle?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-style]');
    if (!button) return;
    applyMapStyle(button.dataset.style);
  });

  el.nearbyBtn.addEventListener('click', () => {
    if (state.tab === 'stops') {
      state.tab = 'vehicles';
      syncTabs();
      renderList();
      return;
    }
    openNearby();
  });

  // Le tendine native su mobile emettono anche `input`: aggiorniamo il raggio
  // solo quando cambia davvero, per non ripetere la richiesta due volte.
  const onRadiusChange = (event) => {
    if (event.target.id !== 'stopsRadius') return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value === state.stopsRadius) return;
    state.stopsRadius = value;
    saveRadius(value);
    loadNearbyStops();
  };
  el.list.addEventListener('change', onRadiusChange);
  el.list.addEventListener('input', onRadiusChange);

  map.on('popupopen', (event) => {
    const button = event.popup.getElement()?.querySelector('[data-stop-focus]');
    if (!button) return;
    button.addEventListener('click', () => {
      map.closePopup();
      state.tab = 'stops';
      syncTabs();
      focusStop(button.dataset.stopFocus);
    });
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
  loadSavedRadius();
  syncTabs();
  setInterval(tick, 1000);
  tick();
  applySavedLocation();
  renderCurrentPosition();
  detectCurrentPosition({ silent: true });

  await Promise.all([loadData(), loadRoutes()]);
  state.nextRefreshAt = Date.now() + REFRESH_MS;
  boot.done = true;

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() >= state.nextRefreshAt) loadData();
  });
}

boot();
