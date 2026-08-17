# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Casual stargazers, aurora chasers, and parents wanting to show a kid a planet
or event — anyone who wants to know "if I step outside *here, tonight*, what
will I actually be able to see?" without owning equipment or domain knowledge.
No accounts; a first-time visitor must get a useful answer immediately.
Explicitly out of scope: telescope/equipment-specific advice, deep-sky object
catalogs, historical trend analysis, social features.

## Product Purpose

Answers "what's viewable in the sky right now, from this exact location" by
combining live cloud cover, moon phase/altitude, light pollution, aurora
probability, and (planned) severe weather, satellite passes, and eclipses into
one plain-language report. Success is a correct, honest answer a non-expert
can act on without visiting five other sites and mentally combining them
itself — including saying "unknown" or degrading gracefully rather than
guessing when a source has nothing for that point.

## Positioning

The single-source combination is the mechanism, not any one data feed —
competitors are single-purpose (a light pollution map, a cloud forecast, an
aurora dashboard) and require the visitor to do the synthesis themselves.
LightMatter's dual-score model (`score`: should I go out tonight;
`potentialScore`: is this location worth a trip at all, independent of
tonight's weather) is a deliberate, testable claim a neighboring product does
not make — both run through the same `scoreFrom(cloud, darkness, aurora)`
formula so they stay comparable rather than drifting into separate
definitions.

## Operating Context

A visitor searches a place name, enters raw coordinates, taps to use device
location, or clicks the map — all four resolve to lat/lon, the shared key
every source is queried by. Mobile use while standing outside is a named use
case (PRD user story 12), so the site must stay readable and operable on a
phone in the field, not just at a desk. The "Find a darker sky" flow
(nearest-dark-site search) is a secondary path off the main report for
visitors whose own location isn't good enough.

## Capabilities and Constraints

- Two 0–100 scores (tonight / potential) plus per-target Likely/Possible/Not
  visible/Unknown verdicts for bright planets, constellations, Milky Way,
  faint objects, and aurora.
- Live sources: NOAA SWPC (aurora), Open-Meteo (clouds, geocoding), OSM
  Nominatim (reverse geocoding, server-side only — browsers can't set the
  required User-Agent header). suncalc computes moon phase/altitude/rise-set
  locally, no network, works for any date.
- Light pollution is a static preprocessed grid (Falchi et al. 2016 World
  Atlas), not live — real skies are typically brighter than reported since
  data vintage is 2014–2015; responses include `dataYear`.
- Every data source must degrade independently (`Promise.allSettled`, never
  `Promise.all`) — one upstream failure must never blank the whole report. A
  genuine failure is a 502; a successful lookup with nothing for that point is
  a 200 with `dataAvailable: false`. These are not interchangeable.
- No accounts/auth. Anonymous by design; "remember last location" is a stated
  future want, not yet built.
- Planned, not yet built: severe weather alerts, satellite passes, naked-eye
  planet positions via local ephemeris, solar eclipses (deferred — need
  narrow-path ground geometry unlike lunar eclipses, which are visible
  anywhere on Earth's night side).
- Accessibility bar: match or exceed the current Impeccable audit score
  (19/20), not a named external standard like WCAG — confirmed, not a gap to
  revisit without reason.

## Brand Commitments

Name is fixed: LightMatter. No voice/personality commitment beyond that yet —
open decision, not to be invented by future design work.

## Evidence on Hand

Real, live API integrations (NOAA SWPC, Open-Meteo, OSM Nominatim) and a real
preprocessed dataset (Falchi et al. 2016 World Atlas, CC BY-NC 4.0 — see
constraint below) — no placeholder or mocked data in the shipped product.
Validated claims worth preserving as evidence: computed full-moon time matches
NASA's greatest-eclipse time to under a minute; Cherry Springs State Park
scores 99 (potential) vs. 57 (full-moon night) vs. Chicago's 19. No
testimonials, case studies, or press exist — do not fabricate any.

## Product Principles

1. **Combine brightness in linear flux, never magnitudes** — averaging
   logarithmic magnitudes computes a geometric mean and has caused three real
   bugs (atlas downsampling, moonlight + skyglow, night-window averaging).
2. **Distinguish "broken" from "nothing to say"** — a failed upstream is a
   502; a successful lookup with no data for that point is 200 with
   `dataAvailable: false`. Collapsing these hides real outages.
3. **One source failing must never fail the response** — every source
   degrades independently; the report always renders what it can.
4. **The two scores must stay comparably defined** — both derive from the
   same formula so their difference stays meaningful rather than becoming two
   independently-drifting numbers.
5. **State data staleness and known bias rather than hiding it** — the atlas
   is 2015 data and biased toward reporting isolated towns as darker than
   reality; the UI says so (`dataYear`) instead of presenting a static grid as
   live truth.

## Accessibility & Inclusion

Standing bar is the existing Impeccable audit score (19/20; the one remaining
point — concurrent backdrop-filter layers — is an intentional exception, not
an open gap). No separate external standard (e.g. WCAG) is targeted at this
time; revisit only if a real requirement emerges.
