---
target: frontend/index.html and styles.css
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-08-13T20-15-46Z
slug: frontend-index-html
---
Method: dual-agent (A: a991c733bb3eb5a15 · B: a9d610d4f1d96eba7)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | No panel loading state; no tile-load indicator; rail open/closed state not announced |
| 2 | Match Between System / Real World | 3 | Domain language correct; internal `data-band` value would fail if surfaced |
| 3 | User Control and Freedom | 2 | No undo for location change; no explicit panel close button; rail has no toggle, only hover |
| 4 | Consistency and Standards | 3 | Strong internal consistency; white logo pill breaks the dark-surface rule |
| 5 | Error Prevention | 2 | No inline search validation; no pre-geolocation explanation; no constraint on submission |
| 6 | Recognition Rather Than Recall | 2 | Quality ramp must be learned; no persistent legend outside rail; score numeral has no inline label |
| 7 | Flexibility and Efficiency of Use | 2 | Two entry paths (search + map click) exist; no keyboard shortcuts, no recent locations, hover rail penalizes touch |
| 8 | Aesthetic and Minimalist Design | 3 | Strong restraint overall; white logo pill is the single significant violator; "coming soon" is noise |
| 9 | Error Recovery | 1 | `.notice` bar is the only error surface; no copy visible in review; toast offers no recovery action |
| 10 | Help and Documentation | 2 | Entry overlay covers basics; no tooltip on score meaning or data fields; no fallback help |
| **Total** | | **22/40** | **Acceptable — significant improvements needed before users are fully happy** |

## Design Specificity Verdict

**LLM assessment:** This is authored. The color vocabulary (`--blood`, `--wine`, `--orchid`, `--ember`, `--peak`) is a deliberate warm-luminosity ramp that encodes sky quality through brightness rather than hue — brighter means better, all in the same family, color-blind safe by construction. The typographic triad (Instrument Serif for wonder, IBM Plex Mono for instrument readouts, IBM Plex Sans for utility) is unusually purposeful. The CSS variable naming alone communicates intent. Where the app becomes generic: the frosted-glass panel, pill search bar, and slide-in info drawer are category idioms shared with Mapbox Studio, Dark Sky's ghost, and Windy.com. The ratio is good, not exceptional — distinctly authored in palette and copy, partially borrowed in interaction patterns.

**Deterministic scan:** 1 finding (exit code 2), severity "warning", category "slop" — `overused-font` triggered on line 15 (the Google Fonts link). **This is a false positive.** The detector's own rule lists Inter, Roboto, Fraunces, Geist, Plus Jakarta Sans, and Space Grotesk as overused faces. None of the three fonts loaded here (Instrument Serif, IBM Plex Sans, IBM Plex Mono) appear on that list. The detector appears to trigger on any Google Fonts request rather than on the specific enumerated faces. No valid findings from the automated scan.

**Visual overlays:** Browser automation unavailable for this session; no live overlay was produced. Fallback signal: detector run was clean (false positive only).

## Overall Impression

The core is right: dark, warm, astronomically-flavored design with a genuine invention in the quality color ramp. The task flow (search → score → plan the night) is emotionally coherent at its peak — the 42px serif numeral in its quality color is the single best moment in the UI. The failures cluster at the edges: discoverability of non-primary controls, absence of loading/error/empty states, accessibility at small text sizes, and a first-visit experience that front-loads configuration over wonder. None of these are structural rearchitects. The biggest single opportunity is turning the entry overlay from an admin checkpoint into an emotional on-ramp.

## What's Working

**1. The quality color ramp is a genuine design invention.** Encoding sky quality as luminosity-on-a-warm-hue rather than red/green is not just color-blind safe — it's semantically correct for astronomy. Brighter means more visible sky. `--peak: #fff4f7` (warm near-white, not pure white) maintains palette cohesion at the best-quality state. This is the kind of decision that distinguishes a designed system from a styled one.

**2. The typographic triad does real work.** Three typefaces each carrying domain meaning creates implicit hierarchy without relying on size alone. The scorebox — 42px serif numeral above a 10px mono label — is a small piece of UI that punches above its weight. It reads like a scientific instrument's face.

**3. The entry overlay gets the voice right.** "Find out what's *actually* visible tonight" is excellent product copy. The italicized "actually" implies other sources let you down; this one is honest. Word choice throughout (`lede`, `eyebrow`, quality band names) shows consistent authorial voice.

## Priority Issues

### [P0] No loading / empty state for the info panel
**Why it matters:** The panel slides in from `translateX(-101%)` but there's no skeleton or indicator between "user clicks map" and "data appears." On slow connections this produces a blank or partially populated panel — which reads as broken, not loading. There's also no design for the app's initial state before any location is selected.
**Fix:** Add a `.loading` modifier on `.info` with shimmer-pulse placeholders at the scoreline and headline positions, using `--ember` at 15% opacity for palette cohesion. The panel should open immediately on click with a loading state, not wait for data.
**Suggested command:** `/impeccable harden`

### [P0] Layer rail is undiscoverable on touch
**Why it matters:** `.rail:hover, .rail:focus-within` are the reveal triggers. Hover doesn't exist on mobile. The 52px exposed tab has no label, no chevron, no affordance language. A first-time mobile user will not find the layer controls.
**Fix:** Add a persistent `<button>` inside the rail's peek zone with a "Layers" label at 10px mono. On touch, toggle on tap rather than hover. On mobile breakpoint, consider promoting layer toggles into the info panel so they're near the data they affect.
**Suggested command:** `/impeccable adapt`

### [P1] White logo pill breaks the visual system and wins every contrast fight
**Why it matters:** `background: #fff` against `var(--ink)` creates roughly 19:1 contrast. The logo will draw the eye before the score, the map, the search bar — before anything meaningful. It breaks the dark-surface rule every other element follows.
**Fix:** Change to `background: color-mix(in srgb, var(--panel) 88%, transparent)` with `border: 1px solid var(--edge-lit)` and `color: var(--rose)` — the standard panel treatment. The logo stays legible without winning the attention contest.
**Suggested command:** `/impeccable polish`

### [P1] Entry overlay front-loads configuration before orientation
**Why it matters:** A first-time user's second cognitive act is deciding whether to enable a layer they've never seen. The disabled "Aurora — coming soon" checkbox adds noise. The sequence wonder → admin choice → proceed deflates the headline's promise.
**Fix:** Remove the `fieldset` from the entry overlay entirely. Move layer discovery to a post-first-use moment (tooltip when rail is first encountered, or a second-visit prompt). Let the card's single job be: create desire, remove friction, end on "Open the map."
**Suggested command:** `/impeccable distill`

### [P2] No recovery path from a bad sky score
**Why it matters:** If the score is "bad," the user sees a blood-colored number, a discouraging headline, and nothing more. The app has fulfilled its contract (honest assessment) but left the user stranded with no path forward.
**Fix:** Add a contextual footer in the info panel — visible only when `data-band` is "poor" or "bad" — using the `.window` callout treatment (brick left-border, low-opacity background): "Skies are poor here tonight. / [Find clearer skies nearby →]". Closes the emotional loop.
**Suggested command:** `/impeccable onboard`

## Persona Red Flags

**Jordan (Confused First-Timer):** Taps "Open the map," the map appears, and there is no persistent on-canvas invitation to act. The search bar at `bottom: 15%` is non-standard; Jordan may not notice it immediately. Nothing says "click the map" or "type here." After 5 seconds of no cue, Jordan taps the logo (does nothing), then the menu. The entry overlay created desire but didn't hand off to a clear next step.

**Sam (Accessibility-Dependent):** The `role="dialog" aria-modal="true"` on the entry overlay is correct. But once inside the app: no `aria-expanded` on rail toggles, no ARIA live region for score updates when a location loads, and the 42px score numeral will be read as a bare number ("73") with no context unless the label below it is encountered in sequence. Critical: text at 9.5px and 10px fails WCAG SC 1.4.4 in practice — `overflow: hidden` on `html, body` actively fights browser zoom, meaning Sam with low vision will hit layout breakage before reaching accessible text sizes.

**Casey (Distracted Mobile User):** At a dark campsite, minimum screen brightness, one hand. The search bar at `bottom: 9%` is in thumb range — good. But the info panel requires scrolling to see the targets and readout below the fold, with no scroll depth indicator. At minimum brightness, `--text-faint: #9d6a7e` labels will be unreadable. The rail at `top: 50%` right-edge sits exactly where a right-handed thumb grazes while scrolling the panel — accidental layer changes are likely. This is an astronomy app; night vision is the literal use case, and there's no low-brightness accommodation.

## Minor Observations

- `var(--wine)` and `var(--edge-lit)` both resolve to `#7a254b` — semantic confusion that will silently diverge in a future update
- `.lede` is defined twice (base block and `.entry-card`); second definition is redundant
- `.primary:hover` shifts text color from near-black to near-white — high-contrast jump that may feel jarring; `var(--peak)` would be smoother
- `.locate.busy` pulses to 35% opacity on an already-dim `var(--brick)` icon — may become invisible on dark backgrounds; 50–55% is safer
- No favicon, no apple-touch-icon linked in `<head>`
- `<main id="ui">` wrapping UI overlays is semantically questionable; the map (`#map`, the primary content) sits outside `<main>`
- `@keyframes pulse` only exists once but there's no `animation-play-state: paused` reset when `.busy` class is removed — verify JS removes class correctly rather than relying on animation ending
