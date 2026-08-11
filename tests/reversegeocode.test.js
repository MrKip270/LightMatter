// Tests for reverse geocoding.
//
// Nominatim is mocked. Beyond the usual reasons, there is a specific one here:
// their usage policy caps us at one request per second and bans IPs that
// exceed it. A test suite that hit the real service would be both slow and a
// good way to get blocked.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { helpers: h } = require("../backend/sources/reversegeocode");

// Captured from a real Nominatim jsonv2 response, trimmed.
const COUDERSPORT = {
  place_id: 123456,
  lat: "41.7745",
  lon: "-78.0203",
  display_name: "Potter County, Pennsylvania, 16915, United States",
  address: {
    county: "Potter County",
    state: "Pennsylvania",
    "ISO3166-2-lvl4": "US-PA",
    postcode: "16915",
    country: "United States",
    country_code: "us",
  },
};

const CHICAGO = {
  address: {
    city: "Chicago",
    county: "Cook County",
    state: "Illinois",
    country: "United States",
    country_code: "us",
  },
};

// Nominatim answers HTTP 200 with an error object for places it cannot name.
const OPEN_OCEAN = { error: "Unable to geocode" };

globalThis.__realFetch = globalThis.__realFetch || globalThis.fetch;

function mockNominatim(payload, { ok = true, status = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (!ok) return { ok: false, status };
    return { ok: true, status: 200, json: async () => payload };
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function call(query) {
  const app = express();
  app.use("/api/reverse-geocode", require("../backend/routes/reversegeocode"));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const { port } = server.address();
    const response = await globalThis.__realFetch(
      `http://127.0.0.1:${port}/api/reverse-geocode?${query}`
    );
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

// Reset the module-level state shared by every test in this file: the cache, so
// results cannot leak between tests, and the throttle clock, so each test does
// not sit out a full second waiting for the previous one's rate limit.
//
// The throttle test below deliberately does NOT reset in the middle, because
// the waiting is the thing it is checking.
function clearCache() {
  h.cache.clear();
  h._resetThrottleForTests();
}

// --- Label building (pure) ------------------------------------------------------

test("buildLabel prefers the most specific locality available", () => {
  assert.equal(
    h.buildLabel({ city: "Chicago", county: "Cook County", state: "Illinois", country: "United States" }),
    "Chicago, Illinois, United States",
    "city wins over county"
  );

  assert.equal(
    h.buildLabel({ village: "Coudersport", state: "Pennsylvania", country: "United States" }),
    "Coudersport, Pennsylvania, United States"
  );

  // Rural areas often have no city/town/village at all, only a county.
  assert.equal(
    h.buildLabel({ county: "Potter County", state: "Pennsylvania", country: "United States" }),
    "Potter County, Pennsylvania, United States"
  );
});

test("buildLabel omits missing pieces instead of leaving gaps", () => {
  assert.equal(h.buildLabel({ country: "Norway" }), "Norway");
  assert.equal(h.buildLabel({ city: "Tromsø", country: "Norway" }), "Tromsø, Norway");
});

test("buildLabel returns null when there is nothing to name", () => {
  // Open ocean and Antarctic interior genuinely have no place name. Callers
  // fall back to raw coordinates, so null must be distinguishable from a label.
  assert.equal(h.buildLabel({}), null);
  assert.equal(h.buildLabel(undefined), null);
});

test("cacheKey rounds so nearby clicks share an entry", () => {
  // ~100 m of precision: enough that repeated clicks in one spot hit the cache,
  // not so coarse that distinct towns collide.
  assert.equal(h.cacheKey(41.66281, -77.81642), h.cacheKey(41.66299, -77.81601));
  assert.notEqual(h.cacheKey(41.663, -77.816), h.cacheKey(41.673, -77.816));
});

// --- Route behaviour ------------------------------------------------------------

test("returns a friendly label for a named place", async () => {
  clearCache();
  const mock = mockNominatim(CHICAGO);
  try {
    const { status, body } = await call("lat=41.88&lon=-87.63");
    assert.equal(status, 200);
    assert.equal(body.dataAvailable, true);
    assert.equal(body.label, "Chicago, Illinois, United States");
    assert.match(body.attribution, /OpenStreetMap/);
  } finally {
    mock.restore();
  }
});

test("sends the User-Agent Nominatim's policy requires", async () => {
  // The whole reason this route exists on the server rather than in the
  // browser. If this header ever goes missing we would be violating the usage
  // policy silently, and eventually get the IP banned.
  clearCache();
  const mock = mockNominatim(COUDERSPORT);
  try {
    await call("lat=41.77&lon=-78.02");
    assert.equal(mock.calls.length, 1);
    const sent = mock.calls[0].options.headers["User-Agent"];
    assert.match(sent, /LightMatter/, `User-Agent was "${sent}"`);
    assert.match(sent, /https?:\/\//, "includes a contact URL");
  } finally {
    mock.restore();
  }
});

test("an unnameable place degrades to no label, not an error", async () => {
  clearCache();
  const mock = mockNominatim(OPEN_OCEAN);
  try {
    const { status, body } = await call("lat=0&lon=-150");
    assert.equal(status, 200, "the request succeeded; there is just no name");
    assert.equal(body.dataAvailable, false);
    assert.equal(body.label, null);
  } finally {
    mock.restore();
  }
});

test("an upstream failure still returns 200 with no label", async () => {
  // Naming is cosmetic. The sky report needs only coordinates, so a Nominatim
  // outage must not surface as a broken feature — the map falls back to showing
  // raw coordinates and everything else carries on.
  clearCache();
  const mock = mockNominatim(null, { ok: false, status: 503 });
  try {
    const { status, body } = await call("lat=41.88&lon=-87.63");
    assert.equal(status, 200, "a naming failure is not a request failure");
    assert.equal(body.label, null);
    assert.ok(body.detail, "the reason is preserved for debugging");
  } finally {
    mock.restore();
  }
});

test("repeated lookups of the same spot hit the cache", async () => {
  // Map users click around the same area repeatedly. Without a cache, each
  // click would queue behind the one-per-second throttle.
  clearCache();
  const mock = mockNominatim(CHICAGO);
  try {
    const first = await call("lat=41.88&lon=-87.63");
    const second = await call("lat=41.8801&lon=-87.6301");

    assert.equal(mock.calls.length, 1, "only one upstream request for both clicks");
    assert.equal(second.body.cached, true);
    assert.equal(second.body.label, first.body.label);
  } finally {
    mock.restore();
  }
});

test("the throttle spaces out uncached requests", async () => {
  // Nominatim's limit is an absolute maximum of one request per second, and
  // exceeding it gets an IP banned. Enforced server-side because the frontend
  // is not the only possible caller.
  clearCache();
  const mock = mockNominatim(CHICAGO);
  try {
    const startedAt = Date.now();
    await call("lat=10.111&lon=20.222");
    await call("lat=30.333&lon=40.444"); // different cache key, so a real request
    const elapsed = Date.now() - startedAt;

    assert.equal(mock.calls.length, 2);
    assert.ok(
      elapsed >= h.MIN_INTERVAL_MS - 50,
      `two uncached lookups should take at least ${h.MIN_INTERVAL_MS}ms, took ${elapsed}ms`
    );
  } finally {
    mock.restore();
  }
});

test("rejects out-of-range coordinates before calling upstream", async () => {
  clearCache();
  const mock = mockNominatim(CHICAGO);
  try {
    const { status, body } = await call("lat=999&lon=0");
    assert.equal(status, 400);
    assert.match(body.error, /lat must be/);
    assert.equal(mock.calls.length, 0, "no upstream request for invalid input");
  } finally {
    mock.restore();
  }
});
