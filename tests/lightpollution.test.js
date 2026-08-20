// Tests for the light pollution source.
//
// Split into two groups: the pure helpers (always runnable) and the grid lookup
// (needs backend/data/lightpollution.bin, which is committed but may be absent
// on a fresh clone that hasn't run the build tool).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getLightPollution, helpers: h } = require("../backend/sources/lightpollution");

const GRID_PATH = path.join(__dirname, "..", "backend", "data", "lightpollution.bin");
const gridExists = fs.existsSync(GRID_PATH);

function close(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} ± ${tolerance}, got ${actual}`
  );
}

// --- Pure helpers -------------------------------------------------------------

test("naked-eye limiting magnitude matches known sky conditions", () => {
  // A pristine sky reaches about magnitude 6.5 — the classic naked-eye limit,
  // and the anchor the whole scale is calibrated against.
  close(h.nakedEyeLimitingMagnitude(22.0), 6.6, 0.2, "pristine sky");
  close(h.nakedEyeLimitingMagnitude(21.3), 6.3, 0.3, "rural");
  close(h.nakedEyeLimitingMagnitude(17.15), 3.2, 0.3, "inner city");
});

test("nakedEyeLimitingMagnitude matches Schaefer (1990)'s NELM formula", () => {
  // The code's formula was arrived at independently (cited to Unihedron via
  // lightpollutionmap.info FAQ #31), but it is algebraically identical to
  // Schaefer's peer-reviewed sky-brightness/NELM relation, solved for NELM:
  //   NELM = 7.93 - 5*log10(10^((21.58 - sqm)/5) + 1)
  // This test cross-checks against that independently-written form as a
  // characterization test, not a bug fix — it should already pass.
  function schaeferNelm(sqm) {
    return 7.93 - 5 * Math.log10(Math.pow(10, (21.58 - sqm) / 5) + 1);
  }

  for (const sqm of [16, 17.15, 18.5, 19.5, 20.5, 21.3, 21.93, 22]) {
    close(
      h.nakedEyeLimitingMagnitude(sqm),
      schaeferNelm(sqm),
      0.01,
      `SQM ${sqm} against Schaefer's formula`
    );
  }
});

test("limiting magnitude increases monotonically with darkness", () => {
  let previous = -Infinity;
  for (let sqm = 16; sqm <= 22; sqm += 0.25) {
    const magnitude = h.nakedEyeLimitingMagnitude(sqm);
    assert.ok(magnitude > previous, `darker sky must see fainter stars (SQM ${sqm})`);
    previous = magnitude;
  }
});

test("star count is calibrated to the commonly cited figure", () => {
  // "About 2,500-3,000 stars are visible to the naked eye under ideal
  // conditions" is the standard reference figure. If a future change to the
  // visible-fraction constant breaks this, the whole estimate is wrong.
  const pristine = h.visibleStarCount(h.nakedEyeLimitingMagnitude(22));
  assert.ok(
    pristine >= 2400 && pristine <= 3200,
    `pristine sky should show ~2,500-3,000 stars, got ${pristine}`
  );
});

test("star count grows geometrically, not linearly, with magnitude", () => {
  // Each magnitude step roughly triples the count. This is why a small change
  // in sky brightness removes a startling share of the stars, and why the
  // interpolation must happen in log space.
  const atFour = h.visibleStarCount(4);
  const atFive = h.visibleStarCount(5);
  const atSix = h.visibleStarCount(6);

  const firstRatio = atFive / atFour;
  const secondRatio = atSix / atFive;

  close(firstRatio, 3.1, 0.6, "one magnitude roughly triples the count");
  close(secondRatio, 3.0, 0.6, "and again");
});

test("star count interpolates in LOG space between table entries", () => {
  // The geometric-growth test above only samples magnitudes 4, 5 and 6 — all
  // exact entries in the lookup table, so the interpolation code never runs.
  // A mutation swapping log interpolation for linear left the suite green.
  //
  // Halfway between two table entries, the correct answer is their GEOMETRIC
  // mean (log space), not their arithmetic mean. For the 6.0 -> 6.5 bracket
  // (4,800 and 9,100 whole-sky stars) those differ by about 5%, which is small
  // but is exactly the error that compounds across the range.
  const lower = 4800;
  const upper = 9100;
  const fraction = h.VISIBLE_AT_ONCE_FRACTION;

  const geometric = Math.round(Math.sqrt(lower * upper) * fraction);
  const arithmetic = Math.round(((lower + upper) / 2) * fraction);

  const actual = h.visibleStarCount(6.25);

  assert.ok(
    Math.abs(actual - geometric) <= 2,
    `midpoint should be the geometric mean ~${geometric}, got ${actual}`
  );
  assert.notEqual(actual, arithmetic, `must not be the arithmetic mean (${arithmetic})`);
});

test("star count is monotonic and bounded", () => {
  let previous = -Infinity;
  for (let magnitude = 0; magnitude <= 7; magnitude += 0.25) {
    const count = h.visibleStarCount(magnitude);
    assert.ok(count >= previous, `monotonic at magnitude ${magnitude}`);
    assert.ok(count >= 0, "never negative");
    previous = count;
  }
  // Clamped outside the table rather than extrapolating into nonsense.
  assert.equal(h.visibleStarCount(-5), h.visibleStarCount(0));
  assert.equal(h.visibleStarCount(99), h.visibleStarCount(7));
});

test("sky descriptions cover the full range in the right order", () => {
  assert.equal(h.describeSky(21.93), "Pristine dark sky");
  assert.equal(h.describeSky(21.3), "Rural");
  assert.equal(h.describeSky(19.5), "Suburban");
  assert.equal(h.describeSky(17.15), "Inner city");

  // Boundaries: each threshold belongs to the darker band.
  assert.equal(h.describeSky(21.75), "Pristine dark sky");
  assert.notEqual(h.describeSky(21.74), "Pristine dark sky");
});

test("visibility notes promise planets even in the worst skies", () => {
  // Jupiter at magnitude -2.9 sits ~6 magnitudes above an inner-city limit of
  // 3.2 — a factor of about 250 in brightness. Bright point sources punch
  // through skyglow; diffuse ones like the Milky Way do not.
  const innerCity = h.visibilityNote(17.0);
  assert.match(innerCity, /planet/i, "planets survive city glow");

  const pristine = h.visibilityNote(21.9);
  assert.match(pristine, /milky way/i, "the Milky Way needs a dark sky");

  // "Brightest planets", not "planets" — Uranus (+5.4) and Neptune (+7.8) are
  // not naked-eye objects under ANY sky.
  assert.match(innerCity, /brightest planets/i, "qualified, not blanket");
});

test("visibility notes agree with scoring.js's TARGETS about when constellations appear", () => {
  // scoring.js's "Major constellations" target unlocks at SQM 17.5 (a Bortle-9
  // floor reading). Below that threshold this text must not claim constellations
  // are gone; below 17.5 it's fine to say so. Keeps the two surfaces — this
  // prose and the TARGETS gate — from silently disagreeing with each other.
  const justAboveGate = h.visibilityNote(17.6);
  assert.doesNotMatch(
    justAboveGate,
    /few dozen stars/i,
    "17.6 clears the constellation gate, so the bottom-tier phrasing must not apply"
  );

  const belowGate = h.visibilityNote(17.4);
  assert.match(belowGate, /few dozen stars/i, "still below the constellation gate");
});

// --- Grid lookup ---------------------------------------------------------------

test("grid lookup returns expected values for known places", { skip: !gridExists }, () => {
  const chicago = getLightPollution(41.8827, -87.6233);
  assert.equal(chicago.dataAvailable, true);
  close(chicago.sqm, 17.15, 0.4, "Chicago Loop");
  assert.equal(chicago.sky, "Inner city");

  const cherrySprings = getLightPollution(41.6628, -77.8164);
  close(cherrySprings.sqm, 21.93, 0.4, "Cherry Springs State Park");
  assert.equal(cherrySprings.sky, "Pristine dark sky");

  // Open ocean has no artificial light at all, so it should sit at the natural
  // sky brightness of exactly 22.00.
  const pacific = getLightPollution(0, -150);
  close(pacific.sqm, 22.0, 0.05, "mid-Pacific");
});

test("dark sites really are darker than cities in the grid", { skip: !gridExists }, () => {
  // Ordering is a stronger guarantee than any single value: if the raster were
  // flipped or offset, exact values might still look plausible while the
  // relationship between places broke.
  const chicago = getLightPollution(41.8827, -87.6233).sqm;
  const cherrySprings = getLightPollution(41.6628, -77.8164).sqm;
  const pacific = getLightPollution(0, -150).sqm;

  assert.ok(cherrySprings > chicago + 3, "the park is far darker than the city");
  assert.ok(pacific >= cherrySprings, "open ocean is the darkest of the three");
});

test("outside the atlas extent returns no data, not an error", { skip: !gridExists }, () => {
  // The atlas covers 85N to 60S. The South Pole is outside it. The request
  // SUCCEEDED — there is simply nothing to report — so this must be a normal
  // response with dataAvailable false, not a thrown error.
  const southPole = getLightPollution(-89, 0);
  assert.equal(southPole.dataAvailable, false);
  assert.equal(southPole.sqm, null);
  assert.match(southPole.visibility, /no light pollution data/i);
});

test("every response carries its licence attribution", { skip: !gridExists }, () => {
  // The dataset is CC BY-NC. Attribution is a legal obligation, not a nicety,
  // so it is asserted rather than assumed.
  const result = getLightPollution(41.88, -87.63);
  assert.match(result.attribution, /Falchi/);
  assert.match(result.attribution, /CC BY-NC/);
});
