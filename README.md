# ATAC Bus Live

Web app che elenca **in tempo reale tutti gli autobus ATAC in circolazione nel comune di Roma**, con mappa, ricerca e filtri per linea.

I dati arrivano dagli open data ufficiali di **Roma Mobilità**:

- **GTFS statico** (`rome_static_gtfs.zip`) per linee, corse, capolinea e tracciati.
- **GTFS‑Realtime Vehicle Positions** (`rome_rtgtfs_vehicle_positions_feed.pb`) per la posizione dei mezzi, aggiornata ogni ~60 secondi.

Vengono mostrati solo i mezzi dell'operatore **Atac** (`agency_id = OP1`) appartenenti a linee di tipo **bus** (`route_type = 3`): tram e metro sono esclusi.

## Funzionalità

- Mappa degli autobus ATAC con un punto colorato per ogni linea.
- Elenco di tutti i bus attivi, con linea, destinazione, vettura, velocità e stato.
- Elenco completo delle linee ATAC (anche quelle senza mezzi attivi in questo momento).
- Ricerca per linea, numero vettura o destinazione.
- Ricerca della propria posizione con suggerimenti (autocomplete) o geolocalizzazione del browser: centra la mappa e ordina i bus per distanza. All'avvio la casella viene compilata con la via in cui ti trovi, se concedi il permesso di geolocalizzazione; l'ultima posizione rilevata viene ricordata anche ai caricamenti successivi.
- **Fermate vicine**: le fermate ATAC entro un raggio configurabile (250 m – 2 km) dalla tua posizione, con i prossimi passaggi di ogni linea e l'indicazione delle linee che hanno bus in circolazione.
- **Casella "La tua posizione attuale"**: identifica il luogo in cui ti trovi (via e zona), con coordinate, precisione del GPS e stato del permesso di geolocalizzazione.
- Filtro "solo in movimento".
- Selezione di una linea: evidenzia i suoi bus sulla mappa e ne disegna il percorso.
- Aggiornamento automatico ogni 30 secondi, con orario dell'ultima rilevazione.
- Layout responsive: utilizzabile da desktop e da telefono.

## Requisiti

- Node.js 20 o superiore.

## Avvio

```bash
npm install
npm start
```

Apri <http://localhost:3000>.

Al primo avvio il server scarica il GTFS statico (~45 MB) e lo conserva in `.cache/`; viene aggiornato automaticamente ogni 24 ore. Per forzare un nuovo download:

```bash
# PowerShell
$env:GTFS_FORCE_DOWNLOAD=1; npm start
```

Test:

```bash
npm test
```

Variabili d'ambiente opzionali:

| Variabile | Default | Descrizione |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `GTFS_URL` | feed ufficiale Roma Mobilità | URL del GTFS statico |
| `ATAC_RT_URL` | feed ufficiale posizioni | URL del feed GTFS‑Realtime |
| `GTFS_MAX_AGE_HOURS` | `24` | Età massima della cache statica |
| `GTFS_FORCE_DOWNLOAD` | – | Se valorizzata, riscarica il GTFS |
| `ATAC_AGENCY_ID` | `OP1` | ID agenzia ATAC nel GTFS |

## API

| Endpoint | Descrizione |
| --- | --- |
| `GET /api/vehicles` | Snapshot dei bus ATAC attivi (posizione, linea, stato) |
| `GET /api/vehicles?force=1` | Forza una nuova lettura del feed |
| `GET /api/routes` | Elenco di tutte le linee ATAC bus, con bus attivi |
| `GET /api/routes/:routeId/shape` | Tracciato della linea |
| `GET /api/stops/nearby?lat=…&lon=…` | Fermate ATAC vicine e prossimi passaggi (`radius` in metri, default 500, max 2000; `limit`, default 10) |
| `GET /api/health` | Stato del servizio |

Esempio di risposta di `/api/vehicles`:

```json
{
  "generatedAt": "2026-11-10T08:45:12.000Z",
  "feedTimestamp": "2026-11-10T08:45:10.000Z",
  "stats": { "total": 1133, "lines": 208, "moving": 946, "stopped": 187 },
  "vehicles": [
    {
      "id": "52",
      "label": "0101",
      "routeId": "105",
      "line": "105",
      "direction": 0,
      "headsign": "P.za Venezia",
      "lat": 41.874496,
      "lon": 12.567732,
      "bearing": null,
      "speedKmh": 18,
      "status": "Alla fermata",
      "occupancy": "Molti posti liberi",
      "timestamp": 1794300154
    }
  ]
}
```

Esempio (ridotto) di risposta di `/api/stops/nearby`:

```json
{
  "generatedAt": "2026-11-10T10:45:47.000Z",
  "center": { "lat": 41.9013, "lon": 12.5004 },
  "radius": 500,
  "schedule": { "ready": true, "status": "ready", "date": "20261110", "nowMinutes": 706 },
  "stops": [
    {
      "id": "70240",
      "name": "TERMINI (MA-MB-FS)",
      "lat": 41.901158,
      "lon": 12.500047,
      "distance": 33,
      "lines": [
        { "routeId": "649", "line": "649", "headsign": "ZAMA", "waitMinutes": 2, "activeBuses": 6, "nearestBusMeters": 56, "nearestBusLabel": "3523" }
      ]
    }
  ]
}
```

Gli orari sono quelli **programmati** nel GTFS statico (il feed di Roma Mobilità non espone i trip updates): il server tiene in memoria solo le fermate candidate, quindi il primo caricamento di `stop_times.txt` (~230 MB) richiede qualche secondo e avviene in background.

## Struttura

```
server.js           server Express + API
src/gtfs.js         download e parsing del GTFS statico
src/realtime.js     lettura e normalizzazione del feed GTFS‑Realtime
src/stops.js        fermate, orari GTFS e indice spaziale
src/nearby.js       servizio "fermate vicine" ed endpoint /api/stops/nearby
src/geo.js          utilità geografiche (distanze, riquadri, formattazione)
test/               test con `node --test` (npm test)
public/             interfaccia web (Leaflet, nessun build step)
.cache/             GTFS statico scaricato (non versionato)
```

## Note

- La posizione dei mezzi è quella comunicata dal sistema AVM di Roma Mobilità e può risentire di ritardi o malfunzionamenti; non è un dato esaustivo del servizio erogato.
- La ricerca indirizzi usa il servizio [Photon](https://photon.komoot.io/) basato su OpenStreetMap. Il rilevamento della posizione attuale richiede un contesto sicuro (`localhost` o HTTPS).
- L'app non è affiliata ad ATAC, Roma Mobilità o Moovit.
- Dati © Roma Mobilità / ATAC, pubblicati come open data. Mappa © OpenStreetMap contributors, tiles © CARTO.
