# LightMatter

A website that estimates what you can see in the night and day sky from any
location you enter. It combines live cloud cover, satellite/constellation
passes, severe weather alerts, rare sky events (aurora, eclipses, naked-eye
planets), and light-pollution data into a single "what's viewable right now"
answer.

## Status

Early development. Learning project — built step by step.

## Tech stack

- **Backend:** Node.js + JavaScript
- **Database:** PostgreSQL
- **Frontend:** plain HTML / CSS / JavaScript
- **Version control:** Git + GitHub

## Project structure

```
LightMatter/
├── backend/      # Node server: fetches APIs, serves data
│   └── routes/   # one file per data source (clouds, aurora, etc.)
├── frontend/     # what the browser loads (HTML/CSS/JS)
└── docs/         # PRD, architecture notes, decisions
```

## Running it

Not runnable yet — setup in progress.

## Data sources (planned)

- NOAA SWPC — aurora / space weather
- Open-Meteo + NWS/NOAA — clouds and severe weather alerts
- N2YO / CelesTrak — satellite passes
- Light-pollution dataset (static)
