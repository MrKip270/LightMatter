# LightMatter — Roadmap

Last updated: 2026-08-05

What's built, what's left, and what's optional. See [`PRD.md`](PRD.md) for the
product spec and the reasoning behind decisions already made.

---

## Built

| Feature | Endpoint | Notes |
| --- | --- | --- |
| Geocoding + autocomplete | `/api/geocode` | Open-Meteo, name-match filtered |
| Aurora probability | `/api/aurora` | NOAA SWPC OVATION |
| Cloud cover | `/api/clouds` | Tonight's window, sunset→sunrise, best clear run |
| Light pollution | `/api/lightpollution` | Falchi 2015 atlas, 7 km grid, local |
| Moon | `/api/moon` | Phase, altitude, rise/set, next new/full, lunar eclipses |
| Reverse geocoding | `/api/reverse-geocode` | Nominatim proxy, throttled + cached |
| Combined report | `/api/sky` | Two scores, best window, star estimate, target ladder |
| Map picker | — | Leaflet + OSM, lazy-loaded, click to choose a location |
| Test suite | — | 92 tests, `npm test`, no dependencies |

---

## Tier 1 — Needed before this is trustworthy

**1. ~~A real test suite.~~ DONE — 92 tests, `npm test`.** Kept here for the
reasoning, which still applies to everything added from now on. `routes/sky.js`
exports its combining logic as pure functions and every source exports its
helpers, but everything so far has been verified with throwaway scripts. Three
real bugs were caught that way (a "next full moon" in the past, a score reporting
the darkest hour as though it lasted all night, and a fixture asserting an
impossible weather state) — all invisible on inspection, all obvious once actual
numbers were printed. Without a suite, the next refactor silently reintroduces
them. Node's built-in `node:test` needs no dependency.

**2. Error handling for partial failures at the edges.** Independent degradation
works, but the failure paths are only lightly exercised. Worth deliberately
breaking each source and confirming the UI stays coherent.

**3. Rate limiting / caching.** Every search hits Open-Meteo twice and NOAA once.
Fine for one user; not fine if this is ever public. NOAA's OVATION grid updates
every ~5 minutes and is global — cache one copy, not one per request.

---

## Tier 2 — Completes the PRD

**4. Severe weather alerts** (NWS/NOAA, no key). PRD user story 5. Should be able
to override the score entirely: a tornado warning isn't a stargazing condition.

**5. Satellite and ISS passes** (N2YO or CelesTrak, free key). PRD user story 6.
First feature needing a secret, so it also forces the `.env` handling the PRD
planned from day one.

**6. Planets and where to look.** Currently "Bright planets" is a static
threshold — it never checks whether any planets are actually *up*. suncalc
doesn't do planets, so this needs an ephemeris (`astronomy-engine` is a good
candidate: local, no key, same philosophy as the suncalc decision). Would turn a
generic row into "Jupiter, southeast, 40° up at 11 PM."

**7. Solar eclipses.** Deferred deliberately — totality follows a narrow ground
track, so honest per-location reporting needs path geometry, not a date table.
Doing it wrong would confidently send someone outside on a day they'd see
nothing.

---

## Tier 3 — Data quality

**8. Newer light pollution data.** Current grid is 2015; light pollution has
increased since, so the app reports skies as darker than they are. The Lorenz
2024 atlas exists but publishes only rendered images — obtaining the numeric grid
means emailing the author (dlorenz@wisc.edu). The loader reads geometry from the
file header specifically so this is a drop-in swap.

**9. More eclipse entries.** `backend/data/lunar-eclipses.json` currently serves
only the two 2026 eclipses whose times were verified. Known 2027–2028 dates are
recorded but deliberately not served until their times are confirmed against
NASA's canon.

**10. Refine the moonlight model.** `MOON_FULL_ZENITH_SQM = 18.5` is a single
tuning constant standing in for a published range of ~17.8–19.5. A proper
Krisciunas & Schaefer implementation would account for lunar distance (a
supermoon is meaningfully brighter) and atmospheric extinction.

**11. Higher-resolution light pollution.** The 7 km grid drifts up to ~1
magnitude optimistic for small towns ringed by wilderness (Tromsø). A finer grid,
or a hybrid that keeps high resolution near populated areas, would fix it.

---

## Tier 4 — Features worth having

**12. Future dates.** `/api/moon` already accepts `?date=`; Open-Meteo returns
multi-day forecasts. Mostly a matter of plumbing a date through and being honest
that forecast confidence drops with distance.

**13. Saved locations.** The first genuinely relational data in the project, and
therefore the right moment to introduce Postgres — which the PRD deliberately
deferred once the light-pollution grid turned out to be a raster.

**14. Compare locations side by side.** The potential score already makes
locations comparable. "Where should I drive tonight?" is arguably a better
question than "how is it here?"

**15. Find the nearest dark site.** Search the light pollution grid outward for
the closest cell above a target SQM. The data is already in memory; this is a
search problem, not a data problem. Now considerably more compelling with a map
to display the answer on.

**15b. Light pollution overlay on the map.** Deferred when the map was built, to
keep that change reviewable. Two routes: extend `tools/build-lightpollution.js`
to emit a colour-coded world PNG alongside the `.bin` and drop it on as a fixed
`L.imageOverlay` (simple, adds a few MB to the repo), or serve rendered PNG
tiles from the in-memory grid at any zoom (sharper, no repo weight, needs a PNG
encoder and tile maths). Probably the single most visually compelling feature
left, since the data is already owned and loaded.

**16. Hourly forecast chart.** `/api/sky` already returns a full `timeline` with
per-hour cloud cover, moon altitude, and effective SQM. Nothing renders it yet —
the data is sitting there unused.

**17. Twilight handling.** The night window runs sunset→sunrise, but astronomical
twilight lasts up to ~90 minutes past sunset. True dark starts later than the
current window claims, which makes early-evening hours look better than they are.

---

## Tier 5 — Polish and operations

**18. The styling pass.** Deliberately deferred until the data was right. The
`frontend-design` and `web-design-guidelines` skills in `~/.agents/skills/` are
for this.

**19. Accessibility.** Verdict colors currently pair with text labels (good), but
the whole thing needs a keyboard and screen-reader pass. Autocomplete is the
likely weak point — a `<ul>` of click handlers isn't reachable by keyboard.

**20. Deployment.** Nothing is deployed. The 23 MB grid loads into memory at
startup, which rules out some serverless platforms and is worth knowing before
picking a host.

**21. Remember last location.** PRD user story 14. `localStorage`, no backend.

---

## Explicitly out of scope

Per the PRD: user accounts, telescope/equipment recommendations, deep-sky object
catalogs, push notifications, historical trend analysis, native mobile apps, and
social features.

---

## Suggested order

1. ~~Tests~~ — done
2. Twilight handling (4.17) — small fix, real accuracy gain
3. Light pollution overlay on the map (4.15b) — highest visual payoff, data already owned
4. Severe weather (2.4) — completes a PRD story, no key needed
5. Hourly chart (4.16) — data already exists, pure frontend
6. Planets via ephemeris (2.6) — biggest single upgrade to the report
7. Caching (1.3) — before anyone else uses it
8. Styling pass (5.18) — once the content has stopped moving
