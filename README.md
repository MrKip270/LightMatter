# LightMatter

A website that estimates what you can see in the night and day sky from any
location you enter. It combines live cloud cover, satellite/constellation
passes, severe weather alerts, rare sky events (aurora, eclipses, naked-eye
planets), and light-pollution data into a single "what's viewable right now"
answer.

See [`docs/PRD.md`](docs/PRD.md) for the full product spec.

## Status

Early development, built step by step as a learning project. Working today:

- **Location input** — search by city name (with an autocomplete dropdown of
  real, resolvable places), enter raw `(lat, lon)` coordinates, or use the
  browser's "use my location" (GPS).
- **Aurora** — live aurora probability for any location, from NOAA SWPC.
- **Cloud cover** — tonight's hourly cloud forecast from Open-Meteo, sliced to
  the hours between local sunset and sunrise and reduced to a plain-language
  verdict (Clear / Partly cloudy / Overcast). Reports both the night's average
  and the longest unbroken clear stretch, so a night that's clear early and
  clouded over later isn't averaged into a misleading answer.
- **Light pollution** — sky darkness for any coordinate, from a preprocessed
  copy of the Falchi et al. 2016 World Atlas. Reports SQM (magnitudes per square
  arc-second), a plain-language description, and the faintest star magnitude
  visible. No network call; the grid is loaded into memory at startup.
- **Moon** — phase, illuminated fraction, altitude, rise/set, next new and full
  moon, and upcoming lunar eclipses with per-location visibility. Computed
  locally from orbital mechanics, so it works for any date and never fails for
  network reasons.
- **Combined report** — `/api/sky` fans out to every source at once and returns a
  0–100 score, a headline explaining what's limiting it, the **best window**
  tonight (the longest stretch that's both clear and moon-free), and a per-target
  ladder (bright planets / constellations / Milky Way / faint objects / aurora)
  each marked Likely, Possible, Not visible, or Unknown.

Moonlight is folded into an **effective sky brightness** that drives the score
and every target threshold, so the report won't promise the Milky Way on a
full-moon night. The effect is strongly inverse to light pollution — a full moon
costs a dark site ~2.5–3.5 magnitudes but a city site ~0.1, because the city sky
is already brighter than the Moon can make it. Cherry Springs scores **99** at
new moon and **57** at full moon.

Every input method resolves to latitude/longitude, which is the shared key all
data sources are queried by. The browser makes one request; the backend fans out
in parallel and each source degrades independently — if one is down or has no
data for that point, its section says so and the rest of the report still
renders.

## Tech stack

- **Backend:** Node.js + Express (JavaScript)
- **Frontend:** plain HTML / CSS / JavaScript (no framework yet)
- **Database:** PostgreSQL (installed; not yet wired in)
- **Version control:** Git + GitHub

## Project structure

```
LightMatter/
├── backend/
│   ├── server.js            # Express entry point; mounts routes, serves frontend
│   ├── sources/             # DATA LOGIC — no Express, no req/res
│   │   ├── aurora.js        #   getAurora(lat, lon)
│   │   ├── clouds.js        #   getClouds(lat, lon)
│   │   ├── lightpollution.js#   getLightPollution(lat, lon)
│   │   └── moon.js          #   getMoon(lat, lon, date) — local, no network
│   ├── routes/              # HTTP WRAPPERS — validate, call a source, set status
│   │   ├── validate.js      #   shared lat/lon validation
│   │   ├── geocode.js
│   │   ├── aurora.js
│   │   ├── clouds.js
│   │   ├── lightpollution.js
│   │   ├── moon.js
│   │   └── sky.js           #   combines all sources into one verdict
│   └── data/
│       ├── lightpollution.bin  # preprocessed grid (built by tools/, committed)
│       └── lunar-eclipses.json # verified eclipse times
├── frontend/
│   ├── index.html           # page markup
│   ├── styles.css           # styling
│   └── app.js               # location input, autocomplete, fetch + render
├── tools/                   # one-off dev scripts, not part of the server
│   ├── inspect-atlas.js     #   print GeoTIFF header + probe pixels
│   └── build-lightpollution.js  # downsample the atlas into backend/data/
└── docs/
    └── PRD.md               # product requirements
```

**Why `sources/` and `routes/` are separate:** `/api/sky` needs data from every
source. A route cannot sensibly call another route — that would mean a real HTTP
round trip per source, losing error detail and risking the server deadlocking on
itself. Splitting the data logic out means the combined endpoint calls the
sources directly as plain functions, and the combining logic is testable with no
server and no network.

## Running it

Requirements: Node.js (v18+) and npm.

```bash
npm install          # install dependencies (first time only)
npm start            # start the server
```

Then open **http://localhost:3000** in your browser.

## API routes

- `GET /api/sky?lat=<lat>&lon=<lon>` — **the main endpoint.** Returns a 0–100
  score, a headline, per-target verdicts, and the raw payload from every source.
- `GET /api/geocode?q=<place>` — returns matching places with coordinates.
- `GET /api/aurora?lat=<lat>&lon=<lon>` — returns aurora probability for a point.
- `GET /api/clouds?lat=<lat>&lon=<lon>` — returns tonight's cloud cover for a
  point: verdict, average cover, clearest hour, longest clear stretch, and the
  hour-by-hour detail. Responds `200` with `dataAvailable: false` when the
  forecast model has nothing for that point (distinct from a `502`, which means
  the upstream request actually failed).

- `GET /api/moon?lat=<lat>&lon=<lon>[&date=YYYY-MM-DD]` — phase, illumination,
  altitude, rise/set, next new/full moon, and any upcoming lunar eclipse with
  per-location visibility. Accepts any date, past or future.
- `GET /api/lightpollution?lat=<lat>&lon=<lon>` — returns SQM, a plain-language
  sky description, and naked-eye limiting magnitude. Responds `503` if the grid
  hasn't been built yet, `200` with `dataAvailable: false` outside the atlas
  extent (85°N–60°S).

Above the Arctic and Antarctic circles the sun may not rise or set at all, in
which case `/api/clouds` falls back to the whole local day and flags
`polarEdgeCase: true`.

## Rebuilding the light pollution grid

`backend/data/lightpollution.bin` is committed, so **this is not needed to run
the app.** Only redo it to change resolution or swap datasets.

```bash
npm install                       # includes the geotiff dev dependency
# download World_Atlas_2015.zip (653 MB) from the DOI link below, unzip it
# OUTSIDE the repo, then:
node tools/inspect-atlas.js       <path-to>/World_Atlas_2015.tif   # sanity check
node tools/build-lightpollution.js <path-to>/World_Atlas_2015.tif   # ~2 min
```

The build downsamples 30 arcsec → 4 arcmin (8×, ~7 km cells), averaging in
**linear** brightness before converting to SQM. Averaging magnitudes instead
would compute a geometric mean and report cities as darker than they are.

Known limitation: downsampling error scales with how isolated a bright area is.
Chicago drifts 0.01 mag; Tromsø — a small city ringed by dark fjords — drifts
0.96 mag toward "darker than reality".

## Data sources

- **NOAA SWPC** — aurora / space weather (no key). *In use.*
- **Open-Meteo Geocoding** — place name to coordinates (no key). *In use.*
- **Open-Meteo Forecast** — hourly cloud cover, sunrise/sunset (no key). *In use.*
- **suncalc** — moon phase, position, rise/set, computed locally from Meeus'
  *Astronomical Algorithms*. No network, no key. *In use.*
- **NASA/GSFC Five Millennium Canon of Lunar Eclipses** — eclipse times, static
  table. *In use.*
- **World Atlas of Artificial Night Sky Brightness** — light pollution, static
  file. *In use.* Falchi, F. et al. (2016), GFZ Data Services,
  [doi:10.5880/GFZ.1.4.2016.001](https://doi.org/10.5880/GFZ.1.4.2016.001).
  Licensed **CC BY-NC 4.0** — see the licensing note below.
- Planned: NWS/NOAA (severe weather alerts), N2YO / CelesTrak (satellite
  passes), and a rare-sky-events source.

## Licensing note

The light pollution dataset is **CC BY-NC 4.0 (NonCommercial)**. Attribution is
returned in every API response. **This blocks commercial use of LightMatter while
that dataset is included.** The grid loader reads its geometry from the file's
own header rather than hardcoding it, specifically so a differently-licensed or
newer dataset can be dropped in without touching code.

Data vintage is 2014–2015. Light pollution has generally increased since, so real
skies are typically somewhat brighter than reported; responses include
`dataYear` so the UI can say so.

## Roadmap (high level)

Add the remaining data sources (each as its own `backend/routes/` module keyed
by coordinates), combine them into a single comprehensive viewability
score/report per location, then style the interface. Later: choosing a future
date using predictive weather patterns.

Next up:

1. **Test suite** — the combining logic in `routes/sky.js` is exported as pure
   functions and has been exercised by ad-hoc scripts. Wire up a real runner and
   convert those into proper tests. This is the PRD's primary seam.
2. **Rare sky events** — naked-eye planets, comets and asteroids, full and
   blood moons, and solar/lunar eclipses. Source still undecided: a hosted
   astronomy API versus computing positions locally from an ephemeris. Would
   make the "bright planets" target concrete (*which* planets, and where to
   look) instead of a static threshold.
3. **Severe weather alerts** and **satellite passes**, per the PRD.
4. **Solar eclipses** — deferred deliberately. Unlike lunar eclipses, totality
   follows a narrow ground track, so honest per-location reporting needs path
   geometry rather than a date table.
5. **More eclipse entries** — `backend/data/lunar-eclipses.json` lists known
   2027–2028 dates whose times still need verifying against NASA's canon before
   they're served.
6. **Future dates** — `/api/moon` already accepts `?date=`. Open-Meteo returns
   multi-day forecasts, so extending the cloud window is mostly a parameter
   change.

Styling stays deliberately minimal until the remaining data sources land.
