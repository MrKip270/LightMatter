# Tests

81 tests, no dependencies — Node's built-in runner (`node --test`).

## Running them

```bash
npm test              # run once
npm run test:watch    # re-run on save, use this while coding
npm run test:coverage # line/branch/function coverage
```

Run a single file while working on one area:

```bash
node --test tests/moon.test.js
```

Filter to one test by name:

```bash
node --test --test-name-pattern="multiplicative" "tests/**/*.test.js"
```

Quiet output when you only care whether it's green:

```bash
node --test --test-reporter=dot "tests/**/*.test.js"
```

The suite takes under a second and makes **no network calls**, so there is no
reason not to run it constantly. `npm run test:watch` in a spare terminal is the
intended workflow.

## What's here

| File | Covers |
| --- | --- |
| `helpers/fixtures.js` | Shared test data, built the way production builds it |
| `clouds.test.js` | Night-window slicing, clear runs, the null-coercion trap |
| `moon.test.js` | Phase physics, moonlight model, phase-finding invariants, eclipses |
| `lightpollution.test.js` | Limiting magnitude, star counts, grid lookup |
| `sky.test.js` | Scoring, both score types, target verdicts, best window, degradation |
| `reversegeocode.test.js` | Label building, User-Agent policy, throttling, caching |
| `coords.test.js` | Longitude wrapping, latitude clamping, typed-coordinate parsing |
| `routes.test.js` | Status codes, validation, response shape, per-source degradation |

`frontend/coords.js` holds the pure coordinate maths precisely so Node can
`require()` it. `app.js` cannot be tested this way — it calls
`document.getElementById` at load time, which throws outside a browser.
Splitting the pure functions out is what makes them coverable at all.

External APIs are mocked in `routes.test.js` with responses captured from the
real services. Per the PRD, real API calls are exercised manually instead — the
suite must be fast and must not burn rate limits.

The light pollution grid tests **skip** rather than fail if
`backend/data/lightpollution.bin` is missing, so a fresh clone that hasn't run
the build tool still gets a green suite.

## The five kinds of test here

**1. Example tests** — a known input, a known output. `floorToHour("20:10")`
must be `"20:00"`. Cheap and readable, but they only ever prove the cases you
thought of.

**2. Boundary tests** — the exact edges of every threshold, not comfortable
values in the middle. `cloudVerdict(20)` is Clear, `cloudVerdict(21)` is not.
Off-by-one bugs live at boundaries and nowhere else.

**3. Property tests** — statements that must hold across a whole domain, not at
one point. "Consecutive full moons are always ~29.5 days apart, from any
starting date across ten years." These are the expensive ones to write and they
have caught the most.

**4. Regression tests** — a bug that actually happened, pinned so it cannot
return. Each one names the bug and how it was found. Three of these exist and
all three describe real failures from this project.

**5. Degradation tests** — what happens when a source is missing or an upstream
is down. The PRD requires one dead source not to break the page; that is only
true if it's asserted.

## Calibration anchors

Several tests check against published astronomical values rather than against
our own code. These are the ones that would catch a plausible-looking but wrong
model:

- A pristine sky shows **2,500–3,000 stars** to the naked eye
- A pristine sky reaches **magnitude ~6.5**
- A quarter moon delivers **~9%** of a full moon's light, not 50%
- A full moon costs a dark site **~3 magnitudes** of sky brightness
- Our computed full moon of 2026-08-28 matches **NASA's eclipse time** to under
  a minute (a lunar eclipse can only occur at full moon, so NASA's catalog is an
  independent measurement of the same instant)

## Mutation testing: checking the tests themselves

A suite that has never failed is unproven. The way to prove it works is to break
the code deliberately and confirm the suite notices.

```bash
# 1. change something that SHOULD break a test
# 2. npm test  -> expect failures, and read WHICH tests failed
# 3. undo the change
# 4. npm test  -> green again
```

Seven mutations were run against this suite. Three initially passed unnoticed
and produced three new tests:

| Mutation | Caught? | Fix |
| --- | --- | --- |
| Remove the null-cloud-cover guard | 2 tests | — |
| Weighted sum instead of multiplicative score | 4 tests | — |
| Hardcode an aurora bonus into the potential score | **no** | Pin potential to exactly `100 × darknessFactor` |
| Remove the phase-boundary guard | **no** | Test asking at the exact instant of a phase |
| Count a moon below the horizon | 2 tests | — |
| Ignore the lunar phase function | 2 tests | — |
| Linear instead of log star interpolation | **no** | Test a value *between* table entries |

That last one is the clearest lesson: the geometric-growth test sampled
magnitudes 4, 5 and 6 — all exact entries in the lookup table — so the
interpolation code it was supposedly testing never ran.

## Bugs this suite has already caught

Written down because they are the argument for the suite existing.

1. **`nextPhaseAfter` returned a full moon in the past.** The original scan
   stopped when the distance to the target grew; when the phase is already
   moving away, that happens on the first step. Found by printing real values.

2. **Effective sky brightness used the single darkest hour** while the report
   advertised a ten-hour window, inflating a full-moon night from 57 to 74.
   Found by comparing the score against the window it claimed to describe.

3. **A fixture asserted an impossible state** — 95% average cloud cover *and* a
   ten-hour clear run — and the code confidently scored that overcast night
   99/100. The code was right; the fixture was lying. This is why
   `helpers/fixtures.js` derives its summary fields using the real production
   helpers instead of hardcoding them.

4. **`nextPhaseAfter` returned `null` for six of twenty-four cases.** suncalc's
   phase does not always reach exactly 0.5 at full moon (it can peak at 0.4863),
   so the refinement landed back on the current cycle. Found by a property test,
   invisible to every example test.

5. **The fix for #4 introduced a new bug.** Guarding with "must be at least half
   a cycle ahead" discarded legitimate near-term answers — asked on 1 August for
   the next new moon, genuinely 11 days out, it replied 41 days. Found by the
   same property test, which is the point of keeping them.

6. **Map clicks failed after panning past the dateline.** Leaflet renders
   repeated copies of the world and reports the longitude of the copy you
   clicked, so panning east gave 190, 550, 910 — every one rejected by the API's
   -180..180 validation. Found by using the map, not by the suite; the
   regression test came afterwards. A reminder that a green suite is evidence
   about the paths you thought to cover, not proof of correctness.
