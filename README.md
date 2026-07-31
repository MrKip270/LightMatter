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

Every input method resolves to latitude/longitude, which is the shared key all
data sources are queried by.

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
│       └── aurora.js    # coordinates -> aurora probability (NOAA SWPC)
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

## Data sources

- **NOAA SWPC** — aurora / space weather (no key). *In use.*
- **Open-Meteo Geocoding** — place name to coordinates (no key). *In use.*
- Planned: Open-Meteo (cloud cover), NWS/NOAA (severe weather alerts),
  N2YO / CelesTrak (satellite passes), a light-pollution dataset, and a
  rare-sky-events source.

## Roadmap (high level)

Add the remaining data sources (each as its own `backend/routes/` module keyed
by coordinates), combine them into a single comprehensive viewability
score/report per location, then style the interface. Later: choosing a future
date using predictive weather patterns.
