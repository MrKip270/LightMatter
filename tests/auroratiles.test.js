// Tests for aurora map tiles.
//
// Two things are worth checking that light pollution's test suite doesn't
// need to: the live-data cache (grid staleness, the "never fetched yet"
// fallback, cache invalidation on refresh) and the alpha-driven palette
// (probability controls per-pixel transparency here, not just a fixed
// opaque colour blended by layer opacity like the atlas). The projection
// maths is the same formulas as lightpollutiontiles.js, so it gets a lighter
// pass here — enough to catch a copy-paste mistake, not a full re-derivation.

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { PNG } = require("pngjs");

const tiles = require("../backend/sources/auroratiles");
const { helpers: h, TILE_SIZE, MAX_NATIVE_ZOOM } = tiles;

globalThis.__realFetch = globalThis.__realFetch || globalThis.fetch;

async function call(urlPath) {
  const app = express();
  app.use("/api/aurora/tile", require("../backend/routes/auroratiles"));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const { port } = server.address();
    const response = await globalThis.__realFetch(`http://127.0.0.1:${port}${urlPath}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      buffer,
    };
  } finally {
    server.close();
  }
}

// A uniform grid, all cells set to the same probability, so a single sampled
// pixel tells you what the whole tile should look like.
function uniformGrid(probability) {
  return new Uint8Array(h.WIDTH * h.HEIGHT).fill(probability);
}

function decode(buffer) {
  return PNG.sync.read(buffer);
}

function pixelAt(png, x, y) {
  const offset = (y * png.width + x) << 2;
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2], png.data[offset + 3]];
}

// --- Palette -----------------------------------------------------------------

test("0% probability is fully transparent", () => {
  assert.deepEqual(h.colourForProbability(0), [20, 180, 90, 0]);
});

test("palette clamps outside its 0-100 range rather than producing nonsense", () => {
  assert.deepEqual(h.colourForProbability(-5), h.colourForProbability(0), "clamped below");
  assert.deepEqual(h.colourForProbability(150), h.colourForProbability(100), "clamped above");
});

test("alpha rises monotonically with probability", () => {
  // The whole point of this palette: higher probability must never look LESS
  // visible than lower probability.
  let previousAlpha = -1;
  for (let p = 0; p <= 100; p += 5) {
    const [, , , a] = h.colourForProbability(p);
    assert.ok(a >= previousAlpha, `alpha dropped at probability ${p}`);
    previousAlpha = a;
  }
});

test("palette produces a valid colour for every input", () => {
  for (let p = 0; p <= 100; p++) {
    const colour = h.colourForProbability(p);
    assert.equal(colour.length, 4, `probability ${p}`);
    for (const channel of colour) {
      assert.ok(
        Number.isInteger(channel) && channel >= 0 && channel <= 255,
        `probability ${p} produced channel ${channel}`
      );
    }
  }
});

// --- Projection (light pass — see file header) --------------------------------

test("zoom 0 covers the whole Mercator world", () => {
  assert.equal(h.pixelToLon(0, 0, 0), -180);
  assert.equal(h.pixelToLon(0, 0, TILE_SIZE), 180);
});

test("adjacent tiles share an edge exactly", () => {
  assert.equal(h.pixelToLon(5, 3, TILE_SIZE), h.pixelToLon(5, 4, 0));
  assert.equal(h.pixelToLat(5, 3, TILE_SIZE), h.pixelToLat(5, 4, 0));
});

// --- Rendering -----------------------------------------------------------------

test("a 0% grid renders a fully transparent tile", async () => {
  h._reset();
  h._setGridForTests(uniformGrid(0), "2026-01-01T00:00Z", "2026-01-01T01:00Z");

  const buffer = await tiles.renderTile(4, 4, 4);
  const png = decode(buffer);
  const [, , , alpha] = pixelAt(png, 128, 128);
  assert.equal(alpha, 0, "0% probability must be invisible, not a faint wash");
});

test("a 100% grid renders the palette's brightest stop", async () => {
  h._setGridForTests(uniformGrid(100), "2026-01-01T00:00Z", "2026-01-01T01:00Z");

  const buffer = await tiles.renderTile(4, 4, 4);
  const png = decode(buffer);
  const pixel = pixelAt(png, 128, 128);
  assert.deepEqual(pixel, h.colourForProbability(100));
});

test("the tile cache returns the identical buffer until the grid refreshes", async () => {
  h._setGridForTests(uniformGrid(50), "2026-01-01T00:00Z", "2026-01-01T01:00Z");

  const first = await tiles.renderTile(3, 2, 2);
  const second = await tiles.renderTile(3, 2, 2);
  assert.equal(first, second, "same object, not merely equal contents — cache hit");

  // A fresh grid (even with identical values) must invalidate the cache,
  // since renderTile has no way to know the new data matches the old.
  h._setGridForTests(uniformGrid(50), "2026-01-01T00:05Z", "2026-01-01T01:05Z");
  const third = await tiles.renderTile(3, 2, 2);
  assert.notEqual(first, third, "cache must not survive a grid refresh");
});

test("never having fetched successfully renders a blank tile, not an error", async () => {
  const originalFetch = globalThis.fetch;
  h._reset();
  globalThis.fetch = async () => {
    throw new Error("NOAA is unreachable");
  };

  try {
    const buffer = await tiles.renderTile(2, 1, 1);
    const png = decode(buffer);
    const [, , , alpha] = pixelAt(png, 0, 0);
    assert.equal(alpha, 0, "no data yet must not draw anything");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Route -----------------------------------------------------------------------

test("rejects out-of-range tile coordinates without touching the network", async () => {
  const cases = [
    [`/api/aurora/tile/${MAX_NATIVE_ZOOM + 1}/1/1.png`, "zoom beyond native"],
    ["/api/aurora/tile/2/999/1.png", "x beyond 2^z"],
    ["/api/aurora/tile/2/1/999.png", "y beyond 2^z"],
    ["/api/aurora/tile/abc/1/1.png", "non-numeric zoom"],
    ["/api/aurora/tile/-1/0/0.png", "negative zoom"],
  ];

  for (const [urlPath, description] of cases) {
    const { status } = await call(urlPath);
    assert.equal(status, 400, `${description} should be rejected`);
  }
});

test("serves a PNG with a short, live-data cache lifetime", async () => {
  h._setGridForTests(uniformGrid(30), "2026-01-01T00:00Z", "2026-01-01T01:00Z");

  const { status, contentType, cacheControl, buffer } = await call(
    "/api/aurora/tile/2/1/1.png"
  );

  assert.equal(status, 200);
  assert.match(contentType, /image\/png/);
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");

  // Unlike the light-pollution atlas, this refreshes every few minutes —
  // caching it for a day would show a stale storm long after it passed.
  assert.match(cacheControl, /max-age=\d+/);
  assert.doesNotMatch(cacheControl, /immutable/, "live data must not claim immutability");
});

test("the legend is generated from the same palette the tiles use, plus a timestamp", async () => {
  h._setGridForTests(uniformGrid(0), "2026-01-01T00:00Z", "2026-01-01T01:23Z");

  const { status, buffer } = await call("/api/aurora/tile/legend");
  assert.equal(status, 200);

  const body = JSON.parse(buffer.toString());
  assert.equal(body.dataAvailable, true, "a successfully loaded grid, even an old one, counts as available");
  assert.equal(body.stops.length, h.PALETTE.length, "one stop per palette entry");
  assert.equal(body.maxNativeZoom, MAX_NATIVE_ZOOM);
  assert.equal(body.forecastTime, "2026-01-01T01:23Z");
  assert.match(body.source, /NOAA/);

  for (const stop of body.stops) {
    const [r, g, b, a] = h.colourForProbability(stop.probability);
    assert.equal(
      stop.colour,
      `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`,
      `legend colour at probability ${stop.probability}`
    );
  }
});

test("NOAA never answering is a genuine failure, not a quietly empty legend", async () => {
  const originalFetch = globalThis.fetch;
  h._reset();
  globalThis.fetch = async () => {
    throw new Error("NOAA is unreachable");
  };

  try {
    const data = await tiles.legend();
    assert.equal(data.dataAvailable, false);
    assert.equal(data.observationTime, null);
    assert.equal(data.forecastTime, null);

    // The route must surface this as a real failure (502), not a 200 with
    // silently null timestamps — a genuine outage must stay visible in logs
    // instead of looking like an ordinary, quiet "nothing to report" response.
    const { status, buffer } = await call("/api/aurora/tile/legend");
    assert.equal(status, 502);
    const body = JSON.parse(buffer.toString());
    assert.match(body.error, /Could not fetch aurora data/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed fetch is not retried again within the cooldown window", async () => {
  const originalFetch = globalThis.fetch;
  h._reset();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    throw new Error("NOAA is unreachable");
  };

  try {
    // Three separate calls in a row, simulating three separate requests
    // arriving during an outage — none of them concurrent (no shared
    // in-flight promise), so without a cooldown each would fetch on its own.
    await tiles.renderTile(2, 1, 1);
    await tiles.renderTile(2, 1, 1);
    await tiles.legend();
    assert.equal(fetchCount, 1, "the cooldown must block repeated fetch attempts, not just concurrent ones");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
