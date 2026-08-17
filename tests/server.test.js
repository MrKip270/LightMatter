// Tests for backend/server.js — the real Express app, not a copy.
//
// Every other route test builds a fresh express() and mounts one router
// directly, which can never catch anything about how server.js itself wires
// its routes together. Before this file, server.js had zero test coverage.
//
// server.js has two code comments claiming the "/tile" routes for aurora and
// light pollution MUST be mounted before their non-tile siblings, or the
// point-lookup route would swallow "/tile/..." as an invalid coordinate
// query. MUTATION-TESTED (see tests/README.md's culture on this): reordering
// each pair in server.js and hitting a live server showed this is currently
// a NO-OP — both point routers define only an exact `router.get("/", ...)`,
// which does not match a "/tile/..." sub-path regardless of mount order, so
// Express falls through to the next app.use() either way. The comments
// describe a real failure mode, but only if a point router ever gains a more
// permissive route (e.g. a path parameter). So this file does NOT (and
// currently cannot) guard against a reordering — what it does establish is
// real, previously-nonexistent coverage that the real app serves both tile
// endpoints AND still validates the point routes correctly, end-to-end.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const GRID_PATH = path.join(__dirname, "..", "backend", "data", "lightpollution.bin");
const gridExists = fs.existsSync(GRID_PATH);

const NOAA_RESPONSE = {
  "Observation Time": "2026-07-31T18:00:00Z",
  "Forecast Time": "2026-07-31T18:30:00Z",
  coordinates: [[272, 42, 7]],
};

globalThis.__realFetch = globalThis.__realFetch || globalThis.fetch;

async function withServer(fn) {
  const app = require("../backend/server");
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("the real app serves an aurora tile", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => NOAA_RESPONSE,
  });

  try {
    await withServer(async (base) => {
      const response = await globalThis.__realFetch(`${base}/api/aurora/tile/2/1/1.png`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /image\/png/);
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("the real app serves a light-pollution tile", { skip: !gridExists }, async () => {
  await withServer(async (base) => {
    const response = await globalThis.__realFetch(`${base}/api/lightpollution/tile/7/32/47.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/png/);
  });
});

test("the real app still validates coordinates on the point routes themselves", async () => {
  // Confirms the two route families coexist correctly through the real app —
  // the tile paths work (above) AND the point-lookup routes they sit next to
  // still do their own job (reject bad coordinates), on the same live app
  // instance, mounted in the real file's real order.
  await withServer(async (base) => {
    const response = await globalThis.__realFetch(`${base}/api/aurora?lat=999&lon=0`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /lat must be/);
  });
});
