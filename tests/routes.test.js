// Tests for the HTTP layer.
//
// External APIs are MOCKED here, per the PRD's testing decisions: the suite
// must be fast, must not depend on network conditions, and must not burn rate
// limits. Real API calls are exercised manually instead.
//
// What these assert is the wrapper's job — status codes, validation, and the
// shape of the response — not the data logic, which the source tests already
// cover.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("fs");
const path = require("path");

const GRID_PATH = path.join(__dirname, "..", "backend", "data", "lightpollution.bin");
const gridExists = fs.existsSync(GRID_PATH);

// --- Canned upstream responses ------------------------------------------------
// Captured from the real APIs, trimmed. Using a real captured shape matters:
// invented shapes test a parser against data the API never sends.

const OPEN_METEO_RESPONSE = {
  latitude: 41.879498,
  longitude: -87.64974,
  utc_offset_seconds: -18000,
  timezone: "America/Chicago",
  hourly_units: { time: "iso8601", cloud_cover: "%" },
  hourly: {
    time: [
      ...Array.from({ length: 24 }, (_, i) => `2026-07-31T${String(i).padStart(2, "0")}:00`),
      ...Array.from({ length: 24 }, (_, i) => `2026-08-01T${String(i).padStart(2, "0")}:00`),
    ],
    // Clear all night (hours 20-23 and 00-05), cloudy during the day.
    cloud_cover: [
      90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90,
      90, 90, 90, 90, 90, 90, 90, 90, 5, 5, 5, 5,
      5, 5, 5, 5, 5, 5, 90, 90, 90, 90, 90, 90,
      90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90,
    ],
  },
  daily: {
    time: ["2026-07-31", "2026-08-01"],
    sunrise: ["2026-07-31T05:43", "2026-08-01T05:44"],
    sunset: ["2026-07-31T20:10", "2026-08-01T20:09"],
  },
};

const NOAA_RESPONSE = {
  "Observation Time": "2026-07-31T18:00:00Z",
  "Forecast Time": "2026-07-31T18:30:00Z",
  coordinates: [
    [272, 42, 7], // lon 272 (= -88), lat 42 -> Chicago's grid cell
    [19, 70, 45], // Tromsø
  ],
};

// Swap global fetch for a router over our canned responses, and hand back a
// restore function. Node's built-in mock could do this too, but an explicit
// swap makes the mechanism visible rather than magic.
function mockFetch({ failOpenMeteo = false, failNoaa = false } = {}) {
  const original = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const href = String(url);

    if (href.includes("open-meteo")) {
      if (failOpenMeteo) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => OPEN_METEO_RESPONSE };
    }
    if (href.includes("swpc.noaa.gov")) {
      if (failNoaa) return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => NOAA_RESPONSE };
    }
    throw new Error(`unexpected fetch to ${href}`);
  };

  return () => {
    globalThis.fetch = original;
  };
}

// Start the route on an ephemeral port, run a request, shut down.
async function call(routePath, modulePath, query) {
  const app = express();
  app.use(routePath, require(modulePath));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const { port } = server.address();
    const response = await globalThis.__realFetch(
      `http://127.0.0.1:${port}${routePath}?${query}`
    );
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

// Keep a pristine fetch for talking to our own test server, so the mock above
// only ever intercepts calls to the real upstreams.
globalThis.__realFetch = globalThis.fetch;

// --- Validation ----------------------------------------------------------------

test("every route rejects out-of-range coordinates with 400", async () => {
  const routes = [
    ["/api/clouds", "../backend/routes/clouds"],
    ["/api/aurora", "../backend/routes/aurora"],
    ["/api/moon", "../backend/routes/moon"],
    ["/api/lightpollution", "../backend/routes/lightpollution"],
    ["/api/darksite", "../backend/routes/darksite"],
    ["/api/sky", "../backend/routes/sky"],
  ];

  const restore = mockFetch();
  try {
    for (const [path, module] of routes) {
      for (const query of ["lat=999&lon=0", "lat=0&lon=999", "lat=abc&lon=0"]) {
        const { status, body } = await call(path, module, query);
        assert.equal(status, 400, `${path}?${query}`);
        assert.match(body.error, /lat must be/, `${path}?${query}`);
      }
    }
  } finally {
    restore();
  }
});

test("validation happens before any network call is made", async () => {
  // Bad input should never cost an upstream request. If it does, a malicious or
  // buggy client could drive traffic to third-party APIs through us.
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("should not have been called");
  };

  try {
    const { status } = await call("/api/clouds", "../backend/routes/clouds", "lat=999&lon=0");
    assert.equal(status, 400);
    assert.equal(fetchCalls, 0, "no upstream request for invalid input");
  } finally {
    globalThis.fetch = original;
  }
});

test("the moon route rejects an unparseable date", async () => {
  const { status, body } = await call(
    "/api/moon",
    "../backend/routes/moon",
    "lat=41&lon=-87&date=banana"
  );
  assert.equal(status, 400);
  assert.match(body.error, /date must be/);
});

// --- Happy paths ----------------------------------------------------------------

test("clouds route returns a normalized payload from the canned forecast", async () => {
  const restore = mockFetch();
  try {
    const { status, body } = await call(
      "/api/clouds",
      "../backend/routes/clouds",
      "lat=41.88&lon=-87.63"
    );

    assert.equal(status, 200);
    assert.equal(body.dataAvailable, true);
    assert.equal(body.verdict, "Clear", "the canned night is clear during astronomical dark");
    // Astronomical dark in Chicago on 2026-07-31: 22:03 local → 03:50 local.
    // floorToHour gives window 22:00-03:00 = 6 hours. The old assertion was 10
    // (sunset 20:10 → sunrise 05:44) — twilight handling shrinks it correctly.
    assert.equal(body.night.hoursCounted, 6, "astronomical dark 22:03-03:50 local");
    assert.ok(body.bestClearRun, "a usable window was found");
    assert.equal(body.bestClearRun.hours, 6);

    // Open-Meteo snaps to its model grid; we report what it actually used.
    assert.equal(body.location.used.lat, 41.879498);
    assert.equal(body.location.requested.lat, 41.88);
  } finally {
    restore();
  }
});

test("aurora route reads the grid cell for the requested coordinates", async () => {
  const restore = mockFetch();
  try {
    const { status, body } = await call(
      "/api/aurora",
      "../backend/routes/aurora",
      "lat=41.88&lon=-87.63"
    );
    assert.equal(status, 200);
    assert.equal(body.auroraProbability, 7, "matches the canned Chicago cell");
  } finally {
    restore();
  }
});

test("aurora route reports 0 rather than failing outside the grid", async () => {
  const restore = mockFetch();
  try {
    const { body } = await call("/api/aurora", "../backend/routes/aurora", "lat=0&lon=0");
    assert.equal(body.auroraProbability, 0, "no cell means no aurora, not an error");
  } finally {
    restore();
  }
});

test("aurora route's own error shape on a NOAA outage", async () => {
  // The generic 400 table above covers validation; this covers the route's
  // OWN error path independent of sources/aurora.js's internals.
  const restore = mockFetch({ failNoaa: true });
  try {
    const { status, body } = await call(
      "/api/aurora",
      "../backend/routes/aurora",
      "lat=41.88&lon=-87.63"
    );
    assert.equal(status, 502);
    assert.equal(body.error, "Could not fetch aurora data");
    assert.equal(typeof body.detail, "string");
  } finally {
    restore();
  }
});

test("moon route accepts a future date", async () => {
  const { status, body } = await call(
    "/api/moon",
    "../backend/routes/moon",
    "lat=41.66&lon=-77.81&date=2026-08-28"
  );
  assert.equal(status, 200);
  assert.equal(body.phaseName, "Full Moon");
  assert.ok(body.upcomingEclipse, "the eclipse that night is surfaced");
});

// --- Failure handling ------------------------------------------------------------

test("an upstream outage becomes a 502, not a crash", async () => {
  const restore = mockFetch({ failOpenMeteo: true });
  try {
    const { status, body } = await call(
      "/api/clouds",
      "../backend/routes/clouds",
      "lat=41.88&lon=-87.63"
    );
    assert.equal(status, 502);
    assert.match(body.error, /Could not fetch cloud data/);
    assert.ok(body.detail, "the underlying reason is preserved for debugging");
  } finally {
    restore();
  }
});

test("/api/sky degrades per source instead of failing outright", async () => {
  // The PRD's resilience rule, tested at the seam that matters: NOAA is down,
  // but the response is still 200 and the cloud data still arrives.
  const restore = mockFetch({ failNoaa: true });
  try {
    const { status, body } = await call(
      "/api/sky",
      "../backend/routes/sky",
      "lat=41.88&lon=-87.63"
    );

    assert.equal(status, 200, "one dead source must not fail the whole response");
    assert.ok(body.sources.aurora.error, "the failure is reported in its own section");
    assert.equal(body.sources.clouds.dataAvailable, true, "clouds still came through");
    assert.ok(body.sources.moon.dataAvailable, "moon is local, so unaffected");

    const aurora = body.targets.find((t) => t.name === "Aurora");
    assert.equal(aurora.verdict, "Unknown", "and shows as Unknown, not a guess");
  } finally {
    restore();
  }
});

test("/api/sky returns the full documented shape", async () => {
  const restore = mockFetch();
  try {
    const { status, body } = await call(
      "/api/sky",
      "../backend/routes/sky",
      "lat=41.88&lon=-87.63"
    );

    assert.equal(status, 200);
    for (const key of [
      "location",
      "score",
      "potentialScore",
      "potentialLabel",
      "headline",
      "bestWindow",
      "sky",
      "targets",
      "factors",
      "sources",
      "timeline",
    ]) {
      assert.ok(key in body, `response includes "${key}"`);
    }

    assert.ok(Array.isArray(body.targets) && body.targets.length >= 5);
    for (const target of body.targets) {
      assert.ok(["Likely", "Possible", "Not visible", "Unknown"].includes(target.verdict),
        `"${target.verdict}" is one of the four documented verdicts`);
    }
  } finally {
    restore();
  }
});

// --- Darksite --------------------------------------------------------------------
//
// The generic out-of-range-coordinates 400 is already covered by the shared
// route table above. What's specific to this route and was previously
// untested at the HTTP layer: minSqm parsing, the grid-missing 503, and a
// basic happy path for both endpoints.
//
// call() (above) mounts a router directly AT the path it's given, which is
// wrong for darksite's "/" and "/tonight" sub-routes — mounting the whole
// router at ".../tonight" makes Express strip that entire prefix and match
// the router's OWN "/" handler (the plain search), silently calling the
// wrong endpoint. This helper always mounts at the router's real base and
// requests the sub-path explicitly, the way an actual client would.
async function callDarksite(subPath, query) {
  const app = express();
  app.use("/api/darksite", require("../backend/routes/darksite"));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const { port } = server.address();
    const response = await globalThis.__realFetch(
      `http://127.0.0.1:${port}/api/darksite${subPath}?${query}`
    );
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test("darksite route rejects a non-numeric minSqm", { skip: !gridExists }, async () => {
  const { status, body } = await callDarksite("", "lat=41.8827&lon=-87.6233&minSqm=notanumber");
  assert.equal(status, 400);
  assert.equal(body.error, "minSqm must be a number");
});

test("darksite/tonight rejects a non-numeric minSqm the same way", { skip: !gridExists }, async () => {
  // parseMinSqm is shared between the two handlers — this confirms the
  // /tonight route actually wires it up too, not just the plain one.
  const { status, body } = await callDarksite(
    "/tonight",
    "lat=41.8827&lon=-87.6233&minSqm=notanumber"
  );
  assert.equal(status, 400);
  assert.equal(body.error, "minSqm must be a number");
});

test("darksite route returns a real nearest-site result for a lit city", { skip: !gridExists }, async () => {
  const { status, body } = await callDarksite(
    "",
    "lat=41.8827&lon=-87.6233" // Chicago Loop — well-established test coordinate
  );
  assert.equal(status, 200);
  assert.ok(body.found, "Chicago is reliably lit enough that a darker site exists nearby");
  assert.ok(body.distanceKm > 0);
  assert.equal(body.weather, undefined, "the plain search doesn't check weather — that's /tonight's job");
});

test("darksite/tonight route returns a real result, weather-checked", { skip: !gridExists }, async () => {
  const restore = mockFetch();
  try {
    const { status, body } = await callDarksite("/tonight", "lat=41.8827&lon=-87.6233");
    assert.equal(status, 200);
    assert.equal(body.found, true);
    assert.ok(body.weather?.dataAvailable, "the /tonight variant includes a weather check the plain route doesn't");
  } finally {
    restore();
  }
});

test(
  "darksite route reports 503 when the grid hasn't been built",
  // Meaningful only on a fresh clone that hasn't run the build tool — mirrors
  // the inverse of every other grid-dependent test's { skip: !gridExists }.
  { skip: gridExists },
  async () => {
    const { status, body } = await callDarksite("", "lat=41.8827&lon=-87.6233");
    assert.equal(status, 503);
    assert.match(body.error, /Light pollution grid not built/);
  }
);
