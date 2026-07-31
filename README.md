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

Every input method resolves to latitude/longitude, which is the shared key all
data sources are queried by. A search fetches every source in parallel, and each
one degrades independently — if a source is down or has no data for that point,
its card says so and the rest of the report still renders.

## Tech stack

- **Backend:** Node.js + Express (JavaScript)
- **Frontend:** plain HTML / CSS / JavaScript (no framework yet)
- **Database:** PostgreSQL (installed; not yet wired in)
- **Version control:** Git + GitHub

## Project structure

```
LightMatter/
├── backend/
│   ├── server.js        # Express entry point; mounts routes, serves frontend
│   └── routes/
│       ├── geocode.js   # place name -> coordinates (Open-Meteo)
│       ├── aurora.js    # coordinates -> aurora probability (NOAA SWPC)
│       └── clouds.js    # coordinates -> tonight's cloud cover (Open-Meteo)
├── frontend/
│   ├── index.html       # page markup
│   ├── styles.css       # styling
│   └── app.js           # location input, autocomplete, fetch + render
└── docs/
    └── PRD.md           # product requirements
```

## Running it

Requirements: Node.js (v18+) and npm.

```bash
npm install          # install dependencies (first time only)
npm start            # start the server
```

Then open **http://localhost:3000** in your browser.

## API routes

- `GET /api/geocode?q=<place>` — returns matching places with coordinates.
- `GET /api/aurora?lat=<lat>&lon=<lon>` — returns aurora probability for a point.
- `GET /api/clouds?lat=<lat>&lon=<lon>` — returns tonight's cloud cover for a
  point: verdict, average cover, clearest hour, longest clear stretch, and the
  hour-by-hour detail. Responds `200` with `dataAvailable: false` when the
  forecast model has nothing for that point (distinct from a `502`, which means
  the upstream request actually failed).

Above the Arctic and Antarctic circles the sun may not rise or set at all, in
which case `/api/clouds` falls back to the whole local day and flags
`polarEdgeCase: true`.

## Data sources

- **NOAA SWPC** — aurora / space weather (no key). *In use.*
- **Open-Meteo Geocoding** — place name to coordinates (no key). *In use.*
- **Open-Meteo Forecast** — hourly cloud cover, sunrise/sunset (no key). *In use.*
- Planned: NWS/NOAA (severe weather alerts), N2YO / CelesTrak (satellite
  passes), a light-pollution dataset, and a rare-sky-events source.

## Roadmap (high level)

Add the remaining data sources (each as its own `backend/routes/` module keyed
by coordinates), combine them into a single comprehensive viewability
score/report per location, then style the interface. Later: choosing a future
date using predictive weather patterns.

Next up:

1. **Light pollution** — coordinates to a sky-brightness / Bortle-class
   estimate. A static, dated dataset is acceptable.
2. **Rare sky events** — naked-eye planets, comets and asteroids, full and
   blood moons, and solar/lunar eclipses. Source still undecided: a hosted
   astronomy API versus computing positions locally from an ephemeris.
3. **Combined report** — a single `/api/sky` endpoint that fans out to every
   source and returns one verdict, replacing the current per-source cards.
   Today a location can report "aurora possible" and "overcast" side by side and
   leave the user to reconcile them; the combined score is what resolves that.
   This is also the PRD's primary test seam.

Styling stays deliberately minimal until the data sources and combined report
exist.
