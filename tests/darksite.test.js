// Tests for the nearest dark site search.
//
// The core invariant, for BOTH search modes: never recommend somewhere WORSE
// than where the user already is. A candidate must beat the query point's own
// darkness (nearby mode) or its own real tonight-score (tonight mode) — merely
// clearing a fixed floor or a coarse weather verdict is not enough, since the
// query point itself might already be well past either of those.
//
// Needs backend/data/lightpollution.bin, same as lightpollution.test.js —
// skipped if it's absent on a fresh clone that hasn't run the build tool.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  findNearestDarkSite,
  findNearestGoodWeatherDarkSite,
  helpers: h,
} = require("../backend/sources/darksite");
const { darknessFactor } = require("../backend/sources/scoring");
const { getLightPollution } = require("../backend/sources/lightpollution");
const f = require("./helpers/fixtures");

const GRID_PATH = path.join(__dirname, "..", "backend", "data", "lightpollution.bin");
const gridExists = fs.existsSync(GRID_PATH);

// --- Pure helpers ---------------------------------------------------------

test("haversine distance is zero for a point against itself", () => {
  assert.equal(h.haversineKm(41.88, -87.63, 41.88, -87.63), 0);
});

test("haversine distance matches a known great-circle figure", () => {
  // Chicago to New York, commonly cited as roughly 1145 km.
  const km = h.haversineKm(41.8827, -87.6233, 40.7128, -74.006);
  assert.ok(Math.abs(km - 1145) < 30, `expected ~1145 km, got ${km}`);
});

test("km-per-ring-step shrinks toward the poles", () => {
  // Longitude compresses toward the poles (cos(lat)); latitude does not, so
  // the cheapest-axis distance can only shrink as latitude increases.
  const equator = h.kmPerRingStep(0);
  const midLatitude = h.kmPerRingStep(60);
  const nearPole = h.kmPerRingStep(84);
  assert.ok(equator > midLatitude, "60N is cheaper per column than the equator");
  assert.ok(midLatitude > nearPole, "84N is cheaper per column than 60N");
});

test("ring 0 is just the center cell; ring 1 is its 8 neighbours", () => {
  assert.deepEqual([...h.ringCells(10, 10, 0)], [[10, 10]]);

  const ring1 = [...h.ringCells(10, 10, 1)];
  assert.equal(ring1.length, 8, "a Chebyshev ring at radius 1 has 8 cells");
  // Every cell must actually be at Chebyshev distance 1.
  for (const [row, col] of ring1) {
    assert.equal(Math.max(Math.abs(row - 10), Math.abs(col - 10)), 1);
  }
});

test("ring cell count grows by 8 per radius, the ring perimeter", () => {
  for (let radius = 1; radius <= 4; radius++) {
    const count = [...h.ringCells(0, 0, radius)].length;
    assert.equal(count, 8 * radius, `radius ${radius}`);
  }
});

// --- The search: nearby/potential mode ---------------------------------------

test("a genuinely darker cell nearby is preferred over an identical-sqm one farther out", {
  skip: !gridExists,
}, () => {
  // Cherry Springs State Park is ~21.93 SQM. The real grid has a marginally
  // darker cell (21.94) 4.9km away — verified empirically, not assumed.
  const result = findNearestDarkSite(41.6628, -77.8164);
  assert.equal(result.found, true);
  assert.equal(result.originDataAvailable, true);
  assert.equal(result.originSqm, 21.93);
  assert.ok(
    result.lightPollution.sqm > result.originSqm,
    `must be strictly darker than the origin, got ${result.lightPollution.sqm} vs origin ${result.originSqm}`
  );
});

test("a light-polluted city finds a farther, genuinely darker site", { skip: !gridExists }, () => {
  // Chicago Loop is ~17.15 SQM — well under the 21.3 default, so the search
  // must travel to find a qualifying cell.
  const originSqm = getLightPollution(41.8827, -87.6233).sqm;
  const result = findNearestDarkSite(41.8827, -87.6233);
  assert.equal(result.found, true);
  assert.equal(result.originSqm, originSqm);
  assert.ok(result.distanceKm > 10, `expected real travel, got ${result.distanceKm} km`);
  assert.ok(
    result.lightPollution.sqm >= 21.3,
    `found cell must meet the threshold, got ${result.lightPollution.sqm}`
  );
  assert.ok(
    result.lightPollution.sqm > originSqm,
    `must beat Chicago's own ${originSqm}, got ${result.lightPollution.sqm}`
  );
});

test("REGRESSION: an origin that already clears the floor is never sent somewhere darker-sounding but worse", {
  skip: !gridExists,
}, () => {
  // This is the exact shape of the reported bug: a query point whose own sqm
  // (faked here to 21.5, comfortably above the 21.3 default floor) sits closer
  // to a cell that merely clears 21.3 (21.31, at 45.9km — confirmed via the
  // OLD floor-only algorithm) than to any cell that's actually darker than
  // 21.5 itself. The fix must skip the trap and either travel farther to a
  // real improvement, or say found:false — never hand back something dimmer
  // than 21.5.
  const fakeOriginSqm = 21.5;
  const lookupOrigin = () => ({ dataAvailable: true, sqm: fakeOriginSqm });

  const result = findNearestDarkSite(41.8827, -87.6233, 21.3, { lookupOrigin });

  assert.equal(result.dataAvailable, true);
  if (result.found) {
    assert.ok(
      result.lightPollution.sqm > fakeOriginSqm,
      `must be strictly darker than the faked origin sqm ${fakeOriginSqm}, got ${result.lightPollution.sqm}`
    );
  }
});

test("outside the atlas extent returns no data, not an error", { skip: !gridExists }, () => {
  const southPole = findNearestDarkSite(-89, 0);
  assert.equal(southPole.dataAvailable, false);
  assert.equal(southPole.found, undefined);
});

// --- Grid-edge boundary (rowColFor's off-by-one) ---------------------------
//
// outsideExtent is `col0 < 0 || col0 >= width || row0 < 0 || row0 >= height`.
// Every other test in this file queries points well inside the extent, so
// the boundary itself — inclusive on one side, exclusive on the other —
// was never directly pinned. Tested at the source (rowColFor/ringCells)
// rather than through the full findNearestDarkSite search: a query at row 0
// sits on the atlas's pristine ceiling (~22.0 sqm), and findNearestDarkSite
// searches for something DARKER than its own origin — which can never
// succeed there (see the "already clears the floor" regression test below),
// so it burns through the entire bounded search radius before giving up.
// That's real, correct behavior, just an expensive way to test a boundary
// condition that doesn't depend on it. Values are derived from the real
// grid's own meta, not hardcoded, so this stays correct if the grid is ever
// rebuilt at a different resolution.

test("rowColFor at the grid's exact top-left corner lands in bounds", { skip: !gridExists }, () => {
  const { meta } = require("../backend/sources/lightpollutiongrid");
  const { row, col } = h.rowColFor(meta.originY, meta.originX);
  // === rather than assert.equal: floor(0 / negativeResY) is -0 in JS, which
  // is a harmless floating-point quirk (-0 === 0), not a real off-by-one —
  // assert.equal's stricter Object.is-style comparison would fail on it.
  assert.ok(row === 0, `expected row 0, got ${row}`);
  assert.ok(col === 0, `expected col 0, got ${col}`);
});

test("rowColFor just north of the top edge lands out of bounds — the off-by-one", { skip: !gridExists }, () => {
  const { meta } = require("../backend/sources/lightpollutiongrid");
  // originY is the grid's northernmost latitude; anything north of it must
  // map to row -1. This is the exact boundary rowColFor's floor() + the
  // caller's `row0 < 0` check exist to catch.
  const { row } = h.rowColFor(meta.originY + 0.01, meta.originX);
  assert.ok(row < 0, `expected a negative row just north of the edge, got ${row}`);
});

test("rowColFor just west of the left edge lands out of bounds", { skip: !gridExists }, () => {
  const { meta } = require("../backend/sources/lightpollutiongrid");
  const { col } = h.rowColFor(meta.originY, meta.originX - 0.01);
  assert.ok(col < 0, `expected a negative col just west of the edge, got ${col}`);
});

test("a ring search starting at row 0 genuinely produces out-of-bounds cells at radius 1", { skip: !gridExists }, () => {
  // Confirms the clipping guard inside searchCandidates (`if (row < 0 || ...)
  // continue;`) is protecting against a REAL case, not a hypothetical one —
  // any search whose query point sits on the grid's edge reaches negative
  // rows on the very first ring, not some large, hard-to-reach radius.
  const cells = [...h.ringCells(0, 100, 1)];
  const outOfBounds = cells.filter(([row]) => row < 0);
  assert.ok(outOfBounds.length > 0, "ring radius 1 from row 0 must include row -1 cells");
  assert.ok(cells.some(([row]) => row >= 0), "and still include valid, in-bounds cells alongside them");
});

test("a threshold nothing can reach returns found: false, not a crash", { skip: !gridExists }, () => {
  // The natural sky ceiling is ~22.0 (see the mid-Pacific fixture in
  // lightpollution.test.js) — no real place reaches 25. This must degrade
  // gracefully within the search cap rather than scanning forever.
  const result = findNearestDarkSite(39.9, 116.4, 25); // Beijing
  assert.equal(result.dataAvailable, true);
  assert.equal(result.found, false);
  assert.match(result.message, /25 mag\/arcsec/i);
});

test("the threshold is inclusive — a cell exactly at minSqm still qualifies", {
  skip: !gridExists,
}, () => {
  // Chicago's own sqm (~17.15) is far below any nearby qualifying cell, so
  // this isolates the FLOOR's <-vs-<= boundary from the origin-comparison
  // boundary (searching from an already-dark origin like Cherry Springs would
  // instead collide with the new "no strict improvement nearby" path).
  const first = findNearestDarkSite(41.8827, -87.6233, 21.3);
  const exact = findNearestDarkSite(41.8827, -87.6233, first.lightPollution.sqm);
  assert.equal(exact.found, true);
  assert.equal(exact.lightPollution.sqm, first.lightPollution.sqm);
});

test("every found result carries the same attribution as a direct lookup", { skip: !gridExists }, () => {
  const result = findNearestDarkSite(41.8827, -87.6233);
  assert.match(result.lightPollution.attribution, /Falchi/);
  assert.match(result.lightPollution.attribution, /CC BY-NC/);
});

test("an origin landing on a no-data pixel degrades to floor-only, flagged", {
  skip: !gridExists,
}, () => {
  // Simulates a query point sitting exactly on a real-but-missing grid pixel
  // (in bounds, but no reading) — a case getLightPollution's own dataAvailable
  // flag already covers, but one that's impractical to locate a real
  // coordinate for. Uses the same injection seam fetchWeather already
  // established for the weather-aware search, applied to the origin lookup.
  const lookupOrigin = () => ({ dataAvailable: false, sqm: null });

  const withNoOrigin = findNearestDarkSite(41.8827, -87.6233, 21.3, { lookupOrigin });
  const floorOnly = findNearestDarkSite(41.8827, -87.6233, 21.3, {
    lookupOrigin: () => ({ dataAvailable: false }),
  });

  assert.equal(withNoOrigin.originDataAvailable, false);
  assert.equal(withNoOrigin.originSqm, null);
  assert.equal(withNoOrigin.found, true);
  // Degrades to exactly the floor-only answer — no origin to compare against.
  assert.deepEqual(withNoOrigin.location, floorOnly.location);
});

// --- Property: never recommend something darker-sounding but actually worse ---

test("raising the threshold never finds a closer (or equal-but-different) site", {
  skip: !gridExists,
}, () => {
  // The set of qualifying cells only shrinks as the threshold rises, so the
  // nearest one can only get farther away or disappear entirely (found: false).
  const points = [
    [41.8827, -87.6233], // Chicago
    [51.5072, -0.1276], // London
    [35.6762, 139.6503], // Tokyo
    [19.076, 72.8777], // Mumbai
  ];
  const thresholds = [19.5, 20.5, 21.3, 21.75];

  for (const [lat, lon] of points) {
    let previousDistance = -Infinity;
    for (const minSqm of thresholds) {
      const result = findNearestDarkSite(lat, lon, minSqm);
      if (!result.found) continue;
      assert.ok(
        result.distanceKm >= previousDistance - 0.01, // tolerate float noise
        `at (${lat}, ${lon}): threshold ${minSqm} found a CLOSER site (${result.distanceKm} km) than a looser threshold (${previousDistance} km)`
      );
      previousDistance = result.distanceKm;
    }
  }
});

test("PROPERTY: a found result is always strictly darker than the query point itself", {
  skip: !gridExists,
}, () => {
  const points = [
    [41.8827, -87.6233], // Chicago
    [51.5072, -0.1276], // London
    [35.6762, 139.6503], // Tokyo
    [19.076, 72.8777], // Mumbai
    [41.6628, -77.8164], // Cherry Springs — already near-optimal
  ];
  const thresholds = [19.5, 20.5, 21.3, 21.75];

  for (const [lat, lon] of points) {
    const originSqm = getLightPollution(lat, lon).sqm;
    for (const minSqm of thresholds) {
      const result = findNearestDarkSite(lat, lon, minSqm);
      if (!result.found) continue;
      assert.ok(
        darknessFactor(result.lightPollution.sqm) > darknessFactor(originSqm),
        `at (${lat}, ${lon}) threshold ${minSqm}: result sqm ${result.lightPollution.sqm} ` +
          `is not strictly darker than the origin's own ${originSqm}`
      );
    }
  }
});

// --- The search: weather-aware "tonight" mode ---------------------------------
//
// findNearestGoodWeatherDarkSite takes fetchWeather/lookupOrigin overrides so
// these run with no network, the same seam scoring.js's buildReport uses
// (take already-fetched source data rather than fetching it itself). Uses
// tests/helpers/fixtures.js's night() builder so fakes drive genuinely
// different computed scores, not just a boolean flag.

test("prefers the nearest candidate whose real score beats the origin's, skipping worse ones", {
  skip: !gridExists,
}, async () => {
  const calls = [];
  const fetchWeather = async (lat, lon) => {
    const i = calls.length;
    calls.push({ lat, lon });
    if (i === 0) return f.night(f.NEW_MOON_NIGHT, f.BROKEN); // the origin: mediocre
    if (i <= 3) return f.night(f.NEW_MOON_NIGHT, f.OVERCAST); // 3 nearer candidates: worse
    return f.night(f.NEW_MOON_NIGHT, f.CLEAR); // everything from here on: clearly better
  };

  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 8,
    fetchWeather,
  });

  assert.equal(result.found, true);
  assert.equal(result.candidatesChecked, 8);
  assert.ok(result.originScoreAvailable);
  assert.ok(
    result.score > result.originScore,
    `winner's score ${result.score} must beat the origin's ${result.originScore}`
  );
  // calls[0] is the origin; calls[4] is the 4th candidate — the nearest one
  // in the CLEAR group, matching the nearest-first selection.
  assert.deepEqual(result.location, calls[4]);
});

test("returns found:false when no candidate beats the origin's real score tonight", {
  skip: !gridExists,
}, async () => {
  let calls = 0;
  const fetchWeather = async () => {
    calls++;
    // Origin gets great weather; every candidate gets terrible weather —
    // nothing in the pool can possibly beat it.
    return calls === 1
      ? f.night(f.NEW_MOON_NIGHT, f.CLEAR)
      : f.night(f.NEW_MOON_NIGHT, f.OVERCAST);
  };

  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 5,
    fetchWeather,
  });

  assert.equal(result.found, false);
  assert.equal(result.dataAvailable, true);
  assert.equal(result.candidatesChecked, 5);
  assert.ok(result.originScoreAvailable);
  assert.match(result.message, /no cell among/i);
  // The old "fall back to nearest anyway, flagged" fields must be gone.
  assert.equal(result.weatherMatched, undefined);
});

test("a candidate whose forecast fetch fails cannot win, but doesn't crash the batch", {
  skip: !gridExists,
}, async () => {
  let calls = 0;
  const fetchWeather = async () => {
    calls++;
    if (calls === 1) return f.night(f.NEW_MOON_NIGHT, f.BROKEN); // origin: mediocre
    if (calls === 2) throw new Error("network blip"); // 1st candidate: fails
    return f.night(f.NEW_MOON_NIGHT, f.CLEAR); // rest: clearly better
  };

  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 5,
    fetchWeather,
  });

  assert.equal(result.found, true, "a later, genuinely-scoreable candidate still wins");
  assert.ok(result.score > result.originScore);
});

test("origin's own forecast failing falls back to any scoreable candidate, flagged", {
  skip: !gridExists,
}, async () => {
  let calls = 0;
  const fetchWeather = async () => {
    calls++;
    if (calls === 1) throw new Error("origin forecast unavailable");
    return f.night(f.NEW_MOON_NIGHT, f.CLEAR);
  };

  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 5,
    fetchWeather,
  });

  assert.equal(result.originScoreAvailable, false);
  assert.equal(result.originScore, null);
  assert.equal(result.found, true, "any scoreable candidate qualifies when the origin is unknown");
});

test("outside the atlas extent short-circuits before any forecast fetch", { skip: !gridExists }, async () => {
  let calls = 0;
  const fetchWeather = async () => {
    calls++;
    return f.night(f.NEW_MOON_NIGHT, f.CLEAR);
  };

  const result = await findNearestGoodWeatherDarkSite(-89, 0, 21.3, { fetchWeather });

  assert.equal(result.dataAvailable, false);
  assert.equal(calls, 0, "not even the origin's own forecast should be fetched");
});

test("an unreachable threshold returns found:false without calling the forecast fetcher", {
  skip: !gridExists,
}, async () => {
  let calls = 0;
  const fetchWeather = async () => {
    calls++;
    return f.night(f.NEW_MOON_NIGHT, f.CLEAR);
  };

  // Same impossible-threshold Beijing case as the plain search above.
  const result = await findNearestGoodWeatherDarkSite(39.9, 116.4, 25, { fetchWeather });

  assert.equal(result.found, false);
  assert.equal(result.candidatesChecked, 0);
  assert.equal(calls, 0);
});

test("PIN: an exact tie in real tonight-score is not an improvement", { skip: !gridExists }, async () => {
  // Finds the real nearest dark-enough candidate, then fakes the ORIGIN's own
  // light pollution to that exact sqm and gives both identical weather — the
  // closest thing to a guaranteed tie the real grid can produce. A `>=`
  // instead of `>` bug would treat this as an improvement; it must not.
  const nearest = findNearestDarkSite(41.8827, -87.6233, 21.3);
  const tiedSqm = nearest.lightPollution.sqm;
  const lookupOrigin = () => ({ dataAvailable: true, sqm: tiedSqm });
  const clearNight = f.night(f.NEW_MOON_NIGHT, f.CLEAR);
  const fetchWeather = async () => clearNight; // origin and the one candidate: identical

  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 1,
    fetchWeather,
    lookupOrigin,
  });

  assert.equal(result.found, false, `a tied score must not count as an improvement, got score ${result.score}`);
});

test("REGRESSION: candidateCount: 0 degrades to no candidates instead of throwing", { skip: !gridExists }, async () => {
  // Used to throw a TypeError: searchCandidates' early-stop check read
  // candidates[-1] before any candidate had ever been pushed, because
  // count === 0 makes `candidates.length >= count` true on the very first
  // radius. Fixed by short-circuiting count <= 0 to an empty candidate list
  // before the ring walk starts (backend/sources/darksite.js, top of
  // searchCandidates) — asking for the nearest zero candidates is trivially
  // an empty list, no search needed.
  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 0,
  });
  assert.equal(result.dataAvailable, true);
  assert.equal(result.found, false);
  assert.equal(result.candidatesChecked, 0);
});

// --- Property: never recommend a worse real score tonight ---------------------

test("PROPERTY: a found result always scores strictly better tonight than the origin", {
  skip: !gridExists,
}, async () => {
  const points = [
    [41.8827, -87.6233], // Chicago
    [51.5072, -0.1276], // London
    [19.076, 72.8777], // Mumbai
  ];
  // Deterministic per-call cover: origin gets a middling night; candidates
  // alternate between worse and clearly-better fixtures, so every point has a
  // real chance of finding an improvement without being guaranteed one.
  const covers = [f.BROKEN, f.OVERCAST, f.HALF, f.OVERCAST, f.CLEAR, f.OVERCAST, f.CLEAR, f.HALF, f.CLEAR];

  for (const [lat, lon] of points) {
    let i = 0;
    const fetchWeather = async () => f.night(f.NEW_MOON_NIGHT, covers[i++ % covers.length]);

    const result = await findNearestGoodWeatherDarkSite(lat, lon, 21.3, {
      candidateCount: 8,
      fetchWeather,
    });

    if (!result.found) continue;
    assert.ok(
      result.score > result.originScore,
      `at (${lat}, ${lon}): winner's score ${result.score} must beat the origin's ${result.originScore}`
    );
  }
});
