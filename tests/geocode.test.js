// Tests for backend/routes/geocode.js.
//
// No source module exists for geocode — the route calls Open-Meteo's
// geocoding API directly. Before this file, this route (the shared first
// step for every location the app resolves) had zero test coverage: not the
// empty-query rejection, not the name-match reshaping, not the fuzzy-match
// fallback the code's own comment names as the reason it exists, not the
// upstream-failure path.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

globalThis.__realFetch = globalThis.__realFetch || globalThis.fetch;

function mockFetch(payload, { ok = true, status = 200 } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => payload,
  });
  return () => {
    globalThis.fetch = original;
  };
}

async function call(query) {
  const app = express();
  app.use("/api/geocode", require("../backend/routes/geocode"));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const { port } = server.address();
    const response = await globalThis.__realFetch(
      `http://127.0.0.1:${port}/api/geocode${query}`
    );
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test("an empty query is rejected before any network call", async () => {
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("should not have been called");
  };

  try {
    const { status, body } = await call("?q=");
    assert.equal(status, 400);
    assert.match(body.error, /Provide a place name/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a whitespace-only query is also rejected", async () => {
  // Exercises the .trim() the code applies before checking for emptiness —
  // "   " must not sneak past as a "real" query.
  const { status, body } = await call("?q=%20%20%20");
  assert.equal(status, 400);
  assert.match(body.error, /Provide a place name/);
});

test("results are reshaped and filtered to name matches", async () => {
  const restore = mockFetch({
    results: [
      { name: "Chicago", admin1: "Illinois", country: "United States", latitude: 41.85, longitude: -87.65, elevation: 179, timezone: "America/Chicago" },
      { name: "Chicago Heights", admin1: "Illinois", country: "United States", latitude: 41.51, longitude: -87.63 },
      { name: "Rockford", admin1: "Illinois", country: "United States", latitude: 42.27, longitude: -89.09 },
    ],
  });

  try {
    const { status, body } = await call("?q=Chicago");
    assert.equal(status, 200);
    assert.equal(body.results.length, 2, "only names containing the query text");
    assert.deepEqual(Object.keys(body.results[0]).sort(), ["country", "lat", "lon", "name", "region"].sort());
    assert.equal(body.results[0].name, "Chicago");
    assert.equal(body.results[0].region, "Illinois", "admin1 reshaped to region");
    assert.equal(body.results.some((r) => r.name === "Rockford"), false);
  } finally {
    restore();
  }
});

test("falls back to the unfiltered list when the name filter matches nothing", async () => {
  // The exact scenario the code's own comment names: Open-Meteo resolves
  // "Tromso" to its Sámi name "Romssasuolu", so a strict name-contains filter
  // would empty the result list even though the geocoder found the right
  // place. Without the fallback, a real, correct match would look like "no
  // results found" to the user.
  const restore = mockFetch({
    results: [
      { name: "Romssasuolu", admin1: "Troms og Finnmark", country: "Norway", latitude: 69.65, longitude: 18.96 },
    ],
  });

  try {
    const { status, body } = await call("?q=Tromso");
    assert.equal(status, 200);
    assert.equal(body.results.length, 1, "fell back to the unfiltered list rather than returning nothing");
    assert.equal(body.results[0].name, "Romssasuolu");
  } finally {
    restore();
  }
});

test("Open-Meteo's no-match shape (no results key at all) becomes an empty array", async () => {
  const restore = mockFetch({});
  try {
    const { status, body } = await call("?q=Nowhereville");
    assert.equal(status, 200);
    assert.deepEqual(body.results, []);
  } finally {
    restore();
  }
});

test("an upstream failure becomes a 502, not a crash", async () => {
  const restore = mockFetch(null, { ok: false, status: 503 });
  try {
    const { status, body } = await call("?q=Chicago");
    assert.equal(status, 502);
    assert.match(body.error, /Could not geocode location/);
    assert.ok(body.detail, "the underlying reason is preserved for debugging");
  } finally {
    restore();
  }
});
