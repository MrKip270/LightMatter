# LightMatter — Roadmap

Last updated: 2026-08-20

**Live:** [lightmatter.onrender.com](https://lightmatter.onrender.com)

What's built, what's left, and what's optional. See [`PRD.md`](PRD.md) for the
product spec and the reasoning behind decisions already made.

---

## Built

| Feature | Endpoint | Notes |
| --- | --- | --- |
| Geocoding + autocomplete | `/api/geocode` | Open-Meteo, name-match filtered |
| Aurora probability | `/api/aurora` | NOAA SWPC OVATION |
| Cloud cover | `/api/clouds` | WeatherAPI.com, tonight's window, sunset→sunrise, best clear run, 10-min server cache |
| Light pollution | `/api/lightpollution` | Falchi 2015 atlas, 7 km grid, local |
| Moon | `/api/moon` | Phase, altitude, rise/set, next new/full, lunar eclipses |
| Reverse geocoding | `/api/reverse-geocode` | Nominatim proxy, throttled + cached |
| Combined report | `/api/sky` | Two scores, best window, star estimate, target ladder |
| Map picker | — | Leaflet + OSM, lazy-loaded, click to choose a location |
| Light pollution overlay | `/api/lightpollution/tile/...` | Server-rendered PNG tiles, opacity slider, legend |
| Map-first interface | — | Full-bleed map, summary panel, layer rail, locate pin |
| Twilight handling | — | Night window is astronomical dusk→dawn, falls back to sunset/sunrise at high latitudes |
| Nearest dark site | `/api/darksite`, `/api/darksite/tonight` | Grid walk outward from the point; frontend popup offers "clear tonight" vs "dark regardless of forecast" |
| Aurora overlay | `/api/aurora/tile/...` | Server-rendered PNG tiles from NOAA's OVATION grid, 5-min shared cache, opacity slider, legend |
| Test suite | — | 226 tests (225 passed, 1 skipped), `npm test`, no dependencies, grouped-by-file output |
| Deployment | — | Live on Render (`lightmatter.onrender.com`), free tier, `WEATHERAPI_KEY` set in the environment |

---

## Tier 1 — Needed before this is trustworthy

**1. ~~A real test suite.~~ DONE — 226 tests, `npm test`.** Kept here for the
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

**3. Rate limiting / caching.** Partly done. Cloud cover moved from Open-Meteo
Forecast to **WeatherAPI.com** (`WEATHERAPI_KEY` env var) and gained a 10-minute
server-side cache (coordinates rounded to ~0.1°, ~11 km) — this is what actually
forced the move: Render's shared free-tier outbound IP was getting 429s from
other tenants' Open-Meteo traffic, not our own, so switching to a key-scoped
quota fixed it at the root rather than just papering over it with a cache.
NOAA's OVATION grid (aurora) was already cached with the same pattern. Still
uncached: Open-Meteo Geocoding and Nominatim reverse-geocoding.

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

**7. Solar eclipses — as a location summary line, not a map layer.** Totality
follows a narrow ground track, so honest per-location reporting needs path
geometry rather than a date table. The original UI concept called for eclipse
paths drawn on the map; that was dropped. Both lunar and solar eclipses belong
in the **location summary** as a dated line ("partial lunar eclipse in 23 days,
visible here") — a point-in-time fact about one place reads better as a sentence
than as paint spread across a continent, and it does not require inventing
geometry we do not have. Lunar eclipses already render this way in the
prototype; solar needs the ground-track data before it can join them.

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

**11b. ~~Dark-site search can land in water.~~ DONE for ocean/coastal, KNOWN
LIMITATION for large inland water.** Both searches default to `landOnly: true`
and reverse-geocode each candidate (via `reversegeocode.js`, the same
Nominatim call already used to label a clicked point) before returning it,
widening the candidate pool searched so there's a real pool to filter from.
When every dark-enough/score-beating candidate turns out to be water, the
response carries `reason: "no-land-match"` and the frontend prompts the user
to click a spot on the map themselves rather than silently degrading.

Confirmed working for open ocean: Nominatim returns no address at all there,
so it's unambiguous. **Confirmed NOT working for large inland water** (Great
Lakes, Caspian Sea, and similar): a Chicago "best nearby site" search landed
squarely in Lake Michigan, labeled just `"Michigan, United States"` — Nominatim
matched the enclosing *state* boundary polygon (`category: boundary, type:
administrative, addresstype: state`), not a water feature, because OSM has no
finer-grained polygon at that point. This is indistinguishable, using address
fields alone, from a genuinely remote rural point that also only resolves to
state/country with no locality — so tightening the heuristic to require a
locality match would reject real remote dark-sky sites too. Properly fixing
this needs an actual land/water dataset (e.g., Natural Earth's coastline +
lakes polygons) checked directly against candidate coordinates, independent of
Nominatim. Deferred — ocean was the far larger share of the original bug
reports, and Great Lakes-adjacent misses are a much narrower miss surface.

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

**15. ~~Find the nearest dark site.~~ DONE.** `backend/sources/darksite.js`
searches the light pollution grid outward for the closest cell above a target
SQM, served at `/api/darksite`; `/api/darksite/tonight` widens the search to
the nearest few candidates and checks each against the forecast. The frontend
popup offers both recommendations the UI concept called for — nearest dark
site regardless of forecast, and nearest dark site that's also clear tonight —
since a place can be excellent tonight but ordinary in general, or the
reverse. Picking a result navigates to that site's own full report with a
disclaimer and a one-hop back link.

**15b. ~~Light pollution overlay on the map.~~ DONE.** Built as server-rendered
PNG tiles. The `L.imageOverlay` alternative was rejected on inspection: the grid
is EPSG:4326 and Leaflet is EPSG:3857, so a linear corner-to-corner overlay
would misplace high latitudes by hundreds of kilometres.

**15c. ~~Aurora overlay on the map.~~ DONE.** `backend/sources/auroratiles.js`
fetches NOAA's OVATION grid (a full 360x181, 1°-per-cell global grid — no
missing-coverage band to handle, unlike the light-pollution atlas) into an
in-memory cache with a 5-minute TTL shared across all tile requests, rather
than the point endpoint's one-fetch-per-request. Probability drives per-pixel
*alpha* rather than a fixed colour blended by layer opacity, so 0% is
genuinely invisible instead of a faint wash implying "checked, nothing here."
`maxNativeZoom` is capped at 4 (vs. light pollution's 8) since the grid is
~16x coarser. Frontend: an independent toggle + opacity slider in the layers
rail, own colour-key legend, and a "Forecast for HH:MM your time" label read
from NOAA's own forecast timestamp — fetched once at page load, not polled,
consistent with the rest of the site.

**15d. Cloud cover — a summary datapoint, not a map layer.** The original UI
concept called for a cloud overlay; dropped. Open-Meteo is a point query, so
real cloud tiles would need satellite imagery from an entirely different source.
Cloud cover already appears in the location summary as a percentage and a
verdict, which is the more useful form anyway — "82% average tonight, overcast"
answers the question directly, where a grey wash over a map does not.

**16. ~~Hourly forecast chart.~~ DONE.** Two stacked single-axis panels
(`frontend/timelinechart.js`, pure geometry, tested) — cloud cover and
effective SQM never shared one dual-axis chart, since they're different
units. Moon altitude isn't a third trace; its effect is already folded into
effectiveSqm, so it only gets rise/set tick marks. The SQM points are
coloured with the exact same `interpolateColour()` scale the map's
light-pollution legend uses, fed by the same `legendStops` already fetched
for that legend — one physical reading, one colour, everywhere it appears.
Hover crosshair + tooltip, keyboard arrow-key navigation, and a table-view
fallback (accessibility non-negotiable: every charted value reachable
without hovering). One bug caught in browser testing before shipping: the
SQM dot's ring was originally the panel's own background colour (matching
the map legend's separation-ring convention), but the SQM palette runs to
near-black at pristine sites — measured 1.01:1 contrast against the panel,
same silent-failure-legend class of bug as the aurora overlay fix. Ring
colour is a fixed light neutral instead, so the darkest (best) readings
don't become the least visible dots on the chart.

**17. ~~Twilight handling.~~ DONE.** Night window now runs astronomical
dusk→dawn (sun 18° below horizon), with graceful fallback to sunset/sunrise at
high latitudes and the full hourly range in the polar edge case.

---

## Tier 5 — Polish and operations

**18. ~~The styling pass.~~ DONE.** Built as a throwaway prototype at
`frontend/prototype/` with three structurally different variants, then folded in
after variant A won. Rewritten rather than copied — the prototype was written
under prototype constraints (no tests, minimal error handling), so promoting it
directly would have shipped that. Pure formatting was extracted to
`frontend/format.js` and covered by tests on the way in.

Still outstanding from that work: an audit against the Vercel Web Interface
Guidelines using the `web-design-guidelines` skill, which is a reviewer rather
than a designer and is best run now that the markup has settled.

**19. ~~Accessibility.~~ DONE.** Full pass: combobox ARIA pattern for the
autocomplete (was the predicted weak point), keyboard navigation,
`aria-activedescendant`, touch target sizing. Impeccable audit scored 19/20 —
the one remaining point (concurrent backdrop-filter layers) is intentional.

**19b. Remaining Impeccable findings.** Three critique passes over
`frontend/index.html` (`.impeccable/critique/`) on 2026-08-17 drove several
fixes already shipped (score-band contrast, dense-list chunking, the
cloud-verdict contradiction, degraded-source messaging, chart-tooltip
clamping — see `CLAUDE.md`'s current-state log). What's left, all P2/P3:
  - Tiny text under the 11px functional-text floor in more places than the
    first attribution fix covered: `.attrib`, `p.attrib` (info-panel
    sidebar), `.darksite-disclaimer p`. Bump all to ≥12px in one pass rather
    than fixing them one critique cycle at a time.
  - The hourly chart's last two x-axis tick labels can crowd together —
    `xTicks` in `frontend/timelinechart.js` keeps every third hour plus the
    final index unconditionally, with no check for how close that final tick
    sits to its neighbour.
  - `.window-card` (featured best-window card) and `.window` (the
    no-best-window fallback) are two different components carrying two
    different accent tokens (`--peak` vs. `--brick`) for what a user reads as
    the same "best window" concept.
  - Unconfirmed, needs a manual network-tab check: searching "Alice Springs"
    left the search box reading "Australia" after the pin/score/map already
    updated correctly — may be a genuine country-level reverse-geocode
    response for a remote point rather than a bug.
  - No visible cancel/abort control for an in-flight dark-site search.
  - Aurora toggle is discoverable only after opening the layers rail, which
    is exactly the feature the aurora-chaser persona comes to the site for.

**20. ~~Deployment.~~ DONE — live on Render** at
[lightmatter.onrender.com](https://lightmatter.onrender.com). The 23 MB grid
loading into memory at startup ruled out some serverless platforms; Render's
standard Node web service handles it fine. Free tier: the instance spins down
after inactivity, so the first request after idle takes ~30s. Required moving
cloud cover off Open-Meteo (see item 3) since Render's shared outbound IP was
already rate-limited by other tenants' traffic before this app had any real
usage of its own.

**21. Remember last location.** PRD user story 14. `localStorage`, no backend.

---

## Explicitly out of scope

Per the PRD: user accounts, telescope/equipment recommendations, deep-sky object
catalogs, push notifications, historical trend analysis, native mobile apps, and
social features.

---

## Suggested order

1. ~~Tests~~ — done
2. ~~Light pollution overlay~~ — done
3. ~~Twilight handling~~ (4.17) — done
4. ~~Find nearest dark site~~ (4.15) — done
5. ~~Aurora overlay~~ (4.15c) — done
6. ~~Accessibility~~ (5.19) — done
7. ~~Hourly chart~~ (4.16) — done
8. ~~Dark-site search can land in water~~ (3.11b) — done for ocean/coastal; large inland water is a known remaining limitation
9. ~~Deployment~~ (5.20) — done, live on Render
10. ~~Caching~~ (1.3) — partly done; clouds moved to WeatherAPI.com + a 10-min cache (forced by the deploy above), NOAA aurora already cached; geocoding/reverse-geocoding still uncached
11. Severe weather (2.4) — completes a PRD story, no key needed
12. Planets via ephemeris (2.6) — biggest single upgrade to the report
13. Web Interface Guidelines audit (5.18 residual) — run `web-design-guidelines` now that the hourly chart / aurora overlay markup has settled
14. Remaining Impeccable findings (5.19b) — small, mostly independent P2/P3 fixes; can be picked off individually
