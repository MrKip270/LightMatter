// Tests for backend/sources/scoring.js functions not directly exercised
// anywhere else — everything else in this module is already covered via
// tests/sky.test.js, which is the right seam for the combining logic. These
// are the boundary/branch cases that were only ever reached indirectly
// through buildReport, where a coincidental input could mask a real bug at
// the boundary itself. Required directly from scoring.js, not through
// sky.js's re-export, so coverage can't silently vanish behind a naming
// trail back to the wrong file.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeScore,
  describePotential,
  buildStarEstimate,
  cloudCeiling,
  bestEffectiveSqm,
} = require("../backend/sources/scoring");

// --- describePotential: a boundary ladder, same shape as format.js's scoreBand ---

test("describePotential boundaries are inclusive on the low side of each band", () => {
  assert.equal(describePotential(85), "Exceptional dark-sky site");
  assert.equal(describePotential(84), "Good dark site");
  assert.equal(describePotential(65), "Good dark site");
  assert.equal(describePotential(64), "Usable on a clear night");
  assert.equal(describePotential(45), "Usable on a clear night");
  assert.equal(describePotential(44), "Limited by local light pollution");
  assert.equal(describePotential(25), "Limited by local light pollution");
  assert.equal(describePotential(24), "Heavily light polluted");
});

test("describePotential returns null for a null score, not the worst label", () => {
  assert.equal(describePotential(null), null);
});

// --- cloudCeiling: a three-band ladder gating every target's verdict ---

function cloudsWithAverage(averageCloudCover) {
  return { dataAvailable: true, averageCloudCover };
}

// cloudFactor's `1 - averageCloudCover / 100` doesn't land bit-exact on 0.2
// for any integer percentage (binary floating point can't represent 0.2
// exactly via that division) — 80% cover produces 0.19999999999999996, one
// float ulp under the boundary, not the boundary itself. Using the
// bestClearRun/night.hoursCounted path instead (1/5 IS bit-exact) tests the
// real threshold precisely rather than tripping over an unrelated float
// artifact.
function cloudsWithRunFraction(hours, hoursCounted) {
  return {
    dataAvailable: true,
    averageCloudCover: 100, // fromAverage = 0, so max() always picks runFraction
    bestClearRun: { hours },
    night: { hoursCounted },
  };
}

test("cloudCeiling boundaries are exclusive on the low side (< not <=)", () => {
  assert.equal(cloudCeiling(cloudsWithRunFraction(1, 5)), "Possible", "1/5 = 0.20 exactly, not < 0.2");
  assert.equal(cloudCeiling(cloudsWithRunFraction(1, 6)), "Not visible", "1/6 ≈ 0.167, clearly under 0.2");
  assert.equal(cloudCeiling(cloudsWithAverage(45)), "Likely", "1 - 0.45 = 0.55 exactly, not < 0.55");
  assert.equal(cloudCeiling(cloudsWithAverage(46)), "Possible", "1 - 0.46 = 0.54 exactly, just under 0.55");
});

test("cloudCeiling is Unknown, not a guess, when cloud data is missing", () => {
  assert.equal(cloudCeiling(null), "Unknown");
  assert.equal(cloudCeiling({ dataAvailable: false }), "Unknown");
});

// --- computeScore: the aurora-defaulting wiring buildReport always supplies for real ---

test("computeScore treats missing or unavailable aurora as no bonus, not a crash", () => {
  const clouds = cloudsWithAverage(0);
  const withUndefined = computeScore(clouds, 21.3, undefined);
  const withUnavailable = computeScore(clouds, 21.3, { dataAvailable: false, auroraProbability: 99 });
  const withNone = computeScore(clouds, 21.3, { dataAvailable: true, auroraProbability: 0 });
  assert.equal(withUndefined, withNone, "no aurora object at all must score the same as a real zero-probability one");
  assert.equal(withUnavailable, withNone, "an unavailable aurora reading must never leak its stale probability in");
});

// --- buildStarEstimate: the two independent null branches ---

test("buildStarEstimate returns null outright when tonight's sky brightness is unknown", () => {
  assert.equal(buildStarEstimate(null, 21.3), null);
  assert.equal(buildStarEstimate(undefined, 21.3), null);
});

test("buildStarEstimate reports tonight's numbers even when the site's baseline is unknown", () => {
  const result = buildStarEstimate(19.5, null);
  assert.ok(result.visibleTonight > 0, "tonight's estimate doesn't depend on having a baseline");
  assert.equal(result.bestLimitingMagnitude, null);
  assert.equal(result.visibleAtBest, null);
});

// --- bestEffectiveSqm: the no-timeline fallback and the empty-window branch ---

test("bestEffectiveSqm falls back to the site's static light-pollution reading with no timeline", () => {
  assert.equal(
    bestEffectiveSqm(null, null, { dataAvailable: true, sqm: 21.3 }),
    21.3
  );
});

test("bestEffectiveSqm is null with no timeline and no light-pollution reading either", () => {
  assert.equal(bestEffectiveSqm(null, null, { dataAvailable: false }), null);
  assert.equal(bestEffectiveSqm(null, null, null), null);
});

test("bestEffectiveSqm is null when a window is given but no timeline hour falls inside it", () => {
  const timeline = [
    { time: "2026-08-01T20:00", effectiveSqm: 19.0 },
    { time: "2026-08-01T21:00", effectiveSqm: 19.5 },
  ];
  const window = { start: "2026-08-02T02:00", end: "2026-08-02T04:00" }; // doesn't overlap the timeline at all
  assert.equal(bestEffectiveSqm(timeline, window, { dataAvailable: true, sqm: 21.3 }), null);
});
