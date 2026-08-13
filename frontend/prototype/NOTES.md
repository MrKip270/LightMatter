# UI prototype — notes

**Question:** what should LightMatter's main page look like?

One direction now, at `/prototype/`. Throwaway — delete this folder once it has
answered its question, and rewrite the winner properly when folding it in.

---

## Status

Variants B (search-first) and C (compare) were **dropped** after the first pass.
Developing A — `frontend/uiconcepts.txt` as written — from here.

Worth keeping from the discarded pair, if it ever comes up again:

- **B's bottom sheet** beat A's left panel on a phone. A now collapses the panel
  to full width below 46rem, which gets most of the way there.
- **C's pinning** was the only layout that used `potentialScore` for what it was
  built for: comparing places. If the "nearest dark site" feature lands
  (ROADMAP 15), that comparison needs somewhere to live, and C is the sketch.

---

## Verdict

*(fill in as you use it)*

- Works:
- Doesn't:
- Change:

---

## Decisions made since the first pass

**Eclipse paths — dropped as a map layer.** We hold eclipse *times*, not ground
tracks; drawing a path would mean inventing geometry. Eclipses now appear as a
line in the location summary ("partial lunar eclipse in 23 days, visible here"),
which is where a dated, place-specific fact belongs. ROADMAP item 7.

**Cloud cover — dropped as a map layer.** Open-Meteo is a point query, so real
cloud tiles need satellite imagery from a different source entirely. Cloud cover
is a summary datapoint instead — "82% average tonight, overcast" answers the
question better than a grey wash over a continent. ROADMAP item 15d.

**Aurora overlay — kept on the roadmap, not built.** The toggle is present but
disabled, so the layout is judged with it in place. It is the cheapest remaining
layer: NOAA's OVATION is already a global grid and the tile renderer exists.
ROADMAP item 15c.

**Nearest-location recommendation — kept on the roadmap.** The concept asks for
two: nearest place good *tonight*, and nearest place good *in general*. Those
are different answers and the two-score model already supports both.
ROADMAP item 15.

---

## Fix: the blank screen

The first version called `initMap()` before rendering any chrome. Leaflet not
being parsed yet, or any bad tile option, threw — and because the exception
happened before `render()`, nothing was ever drawn. All that remained was
`#map`'s CSS background: a flat dark blue page with no error to explain it.

Two changes:

1. **Chrome renders first, unconditionally.** Map setup happens afterwards,
   inside `try/catch`. Layout work should never depend on the network
   succeeding — the search bar and rail must be visible even offline.
2. **Errors are visible.** A `window.onerror` handler and a `crash()` helper
   paint a red banner across the top instead of failing silently.

---

## Design decisions

**Palette derived from the tile palette.** `--void: #080A1E` is literally the
atlas's "pristine sky" stop, so chrome and data share a colour language.

**Monospace for data.** SQM, coordinates, magnitudes and times are tabular
values that should align — the typeface encodes something true rather than
decorating.

**Night vision mode — dropped for now.** A toggle shifted the whole interface to
red-on-black, grounded in astronomers using red light to preserve dark
adaptation. Removed because the project colourway is *already* warm reds and
plums, so a red mode barely reads as a mode change. Worth revisiting only if the
palette moves somewhere cooler.

**Palette is on text, outlines and borders — never the overlay.** The project
colourways (`#b83533 #712983 #3f1021 #7a254b #cf7994 #441539 #5f1621 #992633
#a04089`) drive chrome only. The map overlay keeps the scientific
light-pollution palette, because that one has to stay comparable against Falchi
and Lorenz — and if chrome and data shared hues, a user could not tell
decoration from measurement.

**Quality is encoded by brightness, not hue.** Scores and verdicts run along one
warm ramp in five steps: white (85+) → pink (70) → orange (45) → crimson (20) →
blood. A red/green scale would clash with the palette *and* fail for roughly 8%
of men; a light-to-dark ramp survives both. The orange (`#d9713f`) is the only
colour not in the source swatches — the jump from rose to crimson was too wide
to read as a single step.

**The light pollution overlay is bilinear-sampled, not nearest-neighbour.** Each
tile pixel blends the four surrounding grid cells by distance, so the 7 km cells
no longer show as hard-edged blocks. Done in the renderer rather than with a CSS
blur on purpose: a CSS filter applies per tile, so it would smear each tile
independently and leave a visible seam at every boundary. Cost: tiles are
roughly 13× larger (5.7 KB → 76 KB for Chicago at z7), because smooth gradients
compress far worse than flat blocks. The tile cache limit dropped from 2000 to
400 to compensate.

**The search bar does not move.** Two behaviours removed: the bar migrated to
screen centre while typing (distracting, and it landed on top of the results it
was revealing), and the dropdown was a sibling in normal flow — since the
wrapper is anchored by its *bottom* edge, a tall list grew the box upward and
shoved the bar up the screen. The dropdown is now absolutely positioned and
opens upward, so nothing it does can move the bar. The toast follows the same
rule for the same reason.

**Locate pin lives inside the search bubble**, right-hand end, behind a hairline
divider so it reads as its own action rather than as decoration in the text
field. Three things it needs that a naive version skips:

- **A working state.** A permission prompt or GPS fix takes seconds; without the
  pulse, the first tap reads as a dead button.
- **Named failure causes.** "Location unavailable" is not actionable. Permission
  denied, timeout and everything else get distinct messages, because only the
  first tells someone what to change.
- **HTTPS.** Browsers only expose geolocation over HTTPS or on localhost. Fine
  in development; needs a certificate before this ships.

**Hover rail keeps a tap fallback.** The concept specified hover only, which
would leave the layer toggles unreachable on a phone — PRD user story 12.

**Percentages get floors.** 5% of a 380px screen is a 19px target, under half
the 44px minimum. The panel and rail collapse to usable sizes below 46rem.

**Base map is CARTO dark, split into three layers.** The readability fix. The
first version stacked a 55% overlay on a labelled basemap and then dimmed the
whole tile pane with a brightness filter — city names were both covered *and*
darkened. Now CARTO's `dark_nolabels` sits at the bottom, the light pollution
overlay above it, and `dark_only_labels` in a dedicated Leaflet pane on top. The
overlay can run at high opacity without hiding a single place name, and the
basemap needs no dimming at all.

CARTO has its own usage terms — check them before this goes near production.

---

## Logo

`frontend/assets/logo.png`, wired up, with a `◐` glyph fallback if it 404s.

**It is 358 KB**, which is a lot for something rendered 26 px tall — the browser
downloads the full-resolution image and throws almost all of it away. Fine for a
prototype, worth fixing before this ships: export at ~2× the display size, or
convert to SVG if it's vector artwork.

---

## Open questions

- Does the migrating search bar feel good in use, or gimmicky? It now settles
  back down and fills with the chosen place name once a location is picked.
- Is the entry overlay worth its cost? It gates the product before anyone has
  seen it. "Replay intro" in the scaffolding bar re-shows it for testing.
- Does the info panel want to be dismissible once open? Currently ☰ toggles it,
  and the map re-centres when it does.
- Is the default overlay opacity (60%) right now that labels sit above it?
