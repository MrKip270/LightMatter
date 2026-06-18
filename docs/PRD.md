# LightMatter — Product Requirements Document

Status: Draft v1 (early development)
Last updated: 2026-06-18

## Problem Statement

A person who wants to look at the sky — a casual stargazer, an aurora chaser, a
parent hoping to show their kid a planet — has no single, simple way to answer
the question "if I step outside *here, tonight*, what will I actually be able to
see?" The information that determines the answer is scattered across many
sources: cloud cover forecasts, light-pollution maps, aurora/space-weather
dashboards, satellite-pass trackers, severe-weather alerts, and almanacs of
eclipses and planetary visibility. Checking all of them, for one specific
location and date, and mentally combining them is tedious and assumes knowledge most
people don't have. As a result, people miss rare events (auroras, eclipses,
bright planetary viewings) or waste a clear night not knowing it was a good one.

## Solution

A website where the user enters a location of their choice and immediately gets a
plain-language estimate of what is and isn't viewable in the sky for that place,
right now and for the night ahead. The site gathers the relevant live data —
cloud cover, satellite/constellation passes, severe-weather alerts, rare sky
events (aurora, eclipses, naked-eye planets) — plus (non-live) light-pollution
data, date specific weather predictions, and combines them into a single "here's what you can see" answer. The user
does not need to understand any of the underlying data sources; LightMatter does
the gathering and interpretation.

## User Stories

1. As a sky-watcher, I want to enter a location (city name or coordinates), so that I get results specific to where I am or where I plan to be.
2. As a sky-watcher, I want a single summary of what is viewable tonight, so that I don't have to consult multiple websites.
3. As a sky-watcher, I want to see the current and forecast cloud cover for my location, so that I know whether the sky will be clear enough to see anything.
4. As an aurora chaser, I want to know the current aurora probability for my latitude, so that I can decide whether to travel to a dark spot tonight.
5. As a sky-watcher, I want to be warned of severe weather alerts for my location, so that I stay safe and know if conditions rule out viewing.
6. As a satellite spotter, I want to see upcoming visible satellite or ISS passes for my location, so that I can watch them go over.
7. As a casual observer, I want to know which planets are visible to the naked eye tonight and roughly where to look, so that I can find them without equipment.
8. As an eclipse watcher, I want to know if a solar or lunar eclipse is visible from my location and when, so that I don't miss it.
9. As a sky-watcher, I want to understand how dark my sky is (light pollution), so that I have realistic expectations of what's visible from where I am.
10. As a sky-watcher, I want each viewing item labeled as "likely / unlikely / not visible," so that I can quickly judge the night at a glance.
11. As a first-time visitor, I want the site to work without creating an account, so that I can get an answer immediately.
12. As a mobile user, I want the site to be readable and usable on my phone, so that I can check it while outside.
13. As a sky-watcher, I want to optionally use my device's current location, so that I don't have to type it in.
14. As a returning user, I want my last-entered location remembered (later feature), so that I don't re-enter it each visit.
15. As a sky-watcher, I want results to clearly state how fresh the underlying data is, so that I trust the live estimate.
16. As a sky-watcher, I want a graceful message when a data source is unavailable, so that the whole page doesn't break if one API is down.

## Implementation Decisions

- **Architecture:** Two clearly separated parts. A **Node.js + JavaScript backend** that calls external APIs and serves combined results, and a **plain HTML/CSS/JavaScript frontend** that the browser loads. React is deferred until fundamentals are solid.
- **Backend shape:** One route module per data source under `backend/routes/` (e.g. clouds, aurora, severe weather, satellites, sky events). The frontend asks the backend for a location's sky data; the backend fans out to the relevant sources, normalizes their responses, and returns a single combined payload. This keeps each source's logic isolated and independently testable.
- **Location handling:** The user enters a city/place or coordinates; the backend resolves that to latitude/longitude (geocoding), which is the key every data source is queried by.
- **Database:** **PostgreSQL.** Used for structured/reference data — e.g. cached geocoding results, the static light-pollution lookup, and (later) saved locations. Live API responses are fetched on demand and may be cached short-term; they are not the database's primary purpose initially.
- **Data sources (free tiers):** NOAA SWPC (aurora/space weather, no key), Open-Meteo (cloud cover, no key), NWS/NOAA (severe weather alerts, no key), N2YO or CelesTrak (satellite passes, free key), an astronomy source TBD for planets/eclipses, and a static light-pollution dataset.
- **Secrets handling:** API keys live in a `.env` file that is git-ignored from day one; keys are never committed.
- **Resilience:** A failure from one data source must not fail the whole response. Each source's section degrades independently with a clear "unavailable" state.
- **Output model:** Each viewable item is reduced to a simple visibility verdict (e.g. likely / unlikely / not visible) plus supporting detail, so the frontend can present an at-a-glance summary.

## Testing Decisions

- **Test external behavior, not internals.** Tests should assert what the backend returns for a given location (the shape and the visibility verdicts), not how it computed them, so refactors don't break tests.
- **Highest sensible seam:** the backend's combined "sky data for a location" endpoint is the primary seam to test — feeding it a known location and asserting the normalized, combined result. This covers the fan-out logic with one seam rather than testing each API call in isolation.
- **External APIs are mocked** in tests so the suite is fast and doesn't depend on live network conditions or burn rate limits; real API calls are exercised manually/integration-style, separately.
- **Per-source normalizers** (the code that turns each API's raw response into LightMatter's common shape) are good unit-test candidates, since they are pure transformations with predictable inputs and outputs.
- No prior art in the repo yet (greenfield); test conventions will be established with the first endpoint.

## Out of Scope

- User accounts, authentication, and login (initial version is anonymous).
- Telescope/equipment-specific recommendations or deep-sky object catalogs.
- Push notifications or alerting when conditions become favorable.
- Historical analytics or "best night this week" trend analysis.
- Native mobile apps (responsive web only).
- Real-time light-pollution data (a static dataset is acceptable per project goals).
- Social features (sharing, comments, sightings feed).

## Further Notes

- This is a learning project; decisions favor understanding fundamentals over
  shipping speed. Stack: Node.js + JS, PostgreSQL, plain HTML/CSS/JS, Git +
  GitHub (personal account MrKip270), repo at
  https://github.com/MrKip270/LightMatter.
- The astronomy source for planets/eclipses is an open decision: choose between a
  hosted astronomy API and computing positions locally (e.g. an ephemeris
  library). To be decided when that feature is built.
- Light-pollution data format (tile layer vs. point lookup) is undecided and will
  be settled when that feature is built.
