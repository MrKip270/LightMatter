// Tests for the nearest dark site search.
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

// --- The search -------------------------------------------------------------

test("a site that already meets the threshold returns itself", { skip: !gridExists }, () => {
  // Cherry Springs State Park is ~21.93 SQM — already above the 21.3 default.
  const result = findNearestDarkSite(41.6628, -77.8164);
  assert.equal(result.found, true);
  assert.ok(result.distanceKm < 10, `expected near-zero distance, got ${result.distanceKm}`);
  assert.ok(result.lightPollution.sqm >= 21.3);
});

test("a light-polluted city finds a farther, genuinely darker site", { skip: !gridExists }, () => {
  // Chicago Loop is ~17.15 SQM — well under the 21.3 default, so the search
  // must travel to find a qualifying cell.
  const result = findNearestDarkSite(41.8827, -87.6233);
  assert.equal(result.found, true);
  assert.ok(result.distanceKm > 10, `expected real travel, got ${result.distanceKm} km`);
  assert.ok(
    result.lightPollution.sqm >= 21.3,
    `found cell must meet the threshold, got ${result.lightPollution.sqm}`
  );
});

test("outside the atlas extent returns no data, not an error", { skip: !gridExists }, () => {
  const southPole = findNearestDarkSite(-89, 0);
  assert.equal(southPole.dataAvailable, false);
  assert.equal(southPole.found, undefined);
});

test("a threshold nothing can reach returns found: false, not a crash", { skip: !gridExists }, () => {
  // The natural sky ceiling is ~22.0 (see the mid-Pacific fixture in
  // lightpollution.test.js) — no real place reaches 25. This must degrade
  // gracefully within the search cap rather than scanning forever.
  const result = findNearestDarkSite(39.9, 116.4, 25); // Beijing
  assert.equal(result.dataAvailable, true);
  assert.equal(result.found, false);
  assert.match(result.message, /no cell within/i);
});

test("the threshold is inclusive — a cell exactly at minSqm still qualifies", {
  skip: !gridExists,
}, () => {
  // Find a real cell's exact SQM, then search again using that exact value as
  // the threshold. A stray `<` vs `<=` bug would exclude the cell that IS the
  // answer, which "distanceKm < 10" alone wouldn't reliably expose.
  const first = findNearestDarkSite(41.6628, -77.8164); // Cherry Springs
  const exact = findNearestDarkSite(41.6628, -77.8164, first.lightPollution.sqm);
  assert.equal(exact.found, true);
  assert.equal(exact.lightPollution.sqm, first.lightPollution.sqm);
});

test("every found result carries the same attribution as a direct lookup", { skip: !gridExists }, () => {
  const result = findNearestDarkSite(41.8827, -87.6233);
  assert.match(result.lightPollution.attribution, /Falchi/);
  assert.match(result.lightPollution.attribution, /CC BY-NC/);
});

// --- Property: a stricter threshold can never be closer ---------------------

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

// --- The weather-aware search -------------------------------------------------
//
// findNearestGoodWeatherDarkSite takes a fetchWeather override so these run
// with no network, the same seam sky.js uses (buildReport takes already-
// fetched source data rather than fetching it itself).

function fakeClouds(verdict) {
  return { dataAvailable: true, verdict, averageCloudCover: verdict === "Clear" ? 5 : 90 };
}

test("prefers the nearest candidate with clear weather, skipping cloudier closer ones", {
  skip: !gridExists,
}, async () => {
  const calls = [];
  const fetchWeather = async (lat, lon) => {
    const isGood = calls.length === 2; // the 3rd-nearest candidate is clear
    calls.push({ lat, lon });
    return fakeClouds(isGood ? "Clear" : "Overcast");
  };

  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 8,
    fetchWeather,
  });

  assert.equal(result.found, true);
  assert.equal(result.weatherMatched, true);
  assert.equal(result.candidatesChecked, 8);
  assert.deepEqual(result.location, calls[2]);
});

test("falls back to the nearest candidate, flagged, when nothing is clear tonight", {
  skip: !gridExists,
}, async () => {
  const fetchWeather = async () => fakeClouds("Overcast");

  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 5,
    fetchWeather,
  });

  assert.equal(result.found, true);
  assert.equal(result.weatherMatched, false);
  assert.match(result.message, /no clear weather/i);

  // Still the same nearest dark-enough site the plain endpoint would return —
  // the weather check should narrow the choice, never relocate it.
  const plain = findNearestDarkSite(41.8827, -87.6233, 21.3);
  assert.deepEqual(result.location, plain.location);
});

test("a candidate whose forecast fetch fails is treated as not-clear, not fatal", {
  skip: !gridExists,
}, async () => {
  let calls = 0;
  const fetchWeather = async () => {
    calls++;
    if (calls === 1) throw new Error("network blip");
    return fakeClouds("Clear");
  };

  const result = await findNearestGoodWeatherDarkSite(41.8827, -87.6233, 21.3, {
    candidateCount: 5,
    fetchWeather,
  });

  assert.equal(result.found, true);
  assert.equal(result.weatherMatched, true, "the 2nd candidate's success should still win");
});

test("outside the atlas extent short-circuits before any forecast fetch", { skip: !gridExists }, async () => {
  let calls = 0;
  const fetchWeather = async () => {
    calls++;
    return fakeClouds("Clear");
  };

  const result = await findNearestGoodWeatherDarkSite(-89, 0, 21.3, { fetchWeather });

  assert.equal(result.dataAvailable, false);
  assert.equal(calls, 0);
});

test("an unreachable threshold returns found:false without calling the forecast fetcher", {
  skip: !gridExists,
}, async () => {
  let calls = 0;
  const fetchWeather = async () => {
    calls++;
    return fakeClouds("Clear");
  };

  // Same impossible-threshold Beijing case as the plain search above.
  const result = await findNearestGoodWeatherDarkSite(39.9, 116.4, 25, { fetchWeather });

  assert.equal(result.found, false);
  assert.equal(calls, 0);
});
