// Tests for light pollution map tiles.
//
// The projection maths is the risky part. A tile renderer can be off by a
// systematic amount and still LOOK plausible — a slightly stretched map is not
// obviously wrong at a glance, but it would put dark-sky sites in the wrong
// place. So most of these assert geometry against known coordinates rather
// than checking that pixels merely exist.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const tiles = require("../backend/sources/lightpollutiontiles");
const { helpers: h, TILE_SIZE, MAX_NATIVE_ZOOM } = tiles;

const GRID_PATH = path.join(__dirname, "..", "backend", "data", "lightpollution.bin");
const gridExists = fs.existsSync(GRID_PATH);

globalThis.__realFetch = globalThis.__realFetch || globalThis.fetch;

async function call(urlPath) {
  const app = express();
  app.use("/api/lightpollution/tile", require("../backend/routes/lightpollutiontiles"));

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

// --- Projection ------------------------------------------------------------------

test("tile coordinates round-trip back to the point they contain", () => {
  // The core correctness property: converting a coordinate to a tile, then that
  // tile's pixel grid back to coordinates, must bracket the original point.
  // Checked at several latitudes because Mercator distortion grows toward the
  // poles — an error that is invisible at the equator can be large at 70°N.
  const places = [
    ["Chicago", 41.88, -87.63],
    ["Tromsø", 69.65, 18.96],
    ["Sydney", -33.87, 151.21],
    ["Quito", -0.18, -78.47],
    ["Reykjavík", 64.15, -21.94],
  ];

  for (const [name, lat, lon] of places) {
    for (const z of [3, 5, 7, 8]) {
      const tile = h.tileForCoords(lat, lon, z);

      const north = h.pixelToLat(z, tile.y, 0);
      const south = h.pixelToLat(z, tile.y, TILE_SIZE);
      const west = h.pixelToLon(z, tile.x, 0);
      const east = h.pixelToLon(z, tile.x, TILE_SIZE);

      assert.ok(
        lat <= north + 1e-9 && lat >= south - 1e-9,
        `${name} z${z}: latitude ${lat} outside tile bounds ${south}..${north}`
      );
      assert.ok(
        lon >= west - 1e-9 && lon <= east + 1e-9,
        `${name} z${z}: longitude ${lon} outside tile bounds ${west}..${east}`
      );
    }
  }
});

test("zoom 0 covers the whole Mercator world", () => {
  assert.equal(h.pixelToLon(0, 0, 0), -180, "west edge");
  assert.equal(h.pixelToLon(0, 0, TILE_SIZE), 180, "east edge");

  // Web Mercator cannot represent the poles, so it cuts off at ~85.05°.
  assert.ok(Math.abs(h.pixelToLat(0, 0, 0) - 85.0511) < 0.001, "north edge");
  assert.ok(Math.abs(h.pixelToLat(0, 0, TILE_SIZE) + 85.0511) < 0.001, "south edge");
});

test("latitude spacing is non-linear but longitude spacing is linear", () => {
  // This is the whole reason tiles were chosen over a single stretched image.
  // Longitude maps linearly in Mercator; latitude emphatically does not, and a
  // linear image overlay would get it wrong everywhere except the equator.
  const lonStep1 = h.pixelToLon(4, 8, 1) - h.pixelToLon(4, 8, 0);
  const lonStep2 = h.pixelToLon(4, 8, 200) - h.pixelToLon(4, 8, 199);
  assert.ok(Math.abs(lonStep1 - lonStep2) < 1e-9, "longitude steps are uniform");

  // Compare a pixel step near the equator against one near the top of the map.
  const nearEquator = Math.abs(h.pixelToLat(4, 8, 1) - h.pixelToLat(4, 8, 0));
  const nearPole = Math.abs(h.pixelToLat(4, 0, 1) - h.pixelToLat(4, 0, 0));
  assert.ok(
    nearEquator > nearPole * 2,
    `latitude steps must vary with position (${nearEquator} vs ${nearPole})`
  );
});

test("latitude decreases down the tile and longitude increases across it", () => {
  // Tile y increases SOUTHWARD, which is the opposite of latitude. Getting this
  // backwards flips the map vertically — a mistake that renders a
  // plausible-looking but completely wrong image.
  let previousLat = Infinity;
  for (let py = 0; py <= TILE_SIZE; py += 32) {
    const lat = h.pixelToLat(5, 10, py);
    assert.ok(lat < previousLat, `latitude must decrease as pixel row increases (py ${py})`);
    previousLat = lat;
  }

  let previousLon = -Infinity;
  for (let px = 0; px <= TILE_SIZE; px += 32) {
    const lon = h.pixelToLon(5, 10, px);
    assert.ok(lon > previousLon, `longitude must increase as pixel column increases (px ${px})`);
    previousLon = lon;
  }
});

test("adjacent tiles share an edge exactly, with no gap or overlap", () => {
  // If these disagreed, the map would show seams or double-drawn strips.
  for (const z of [2, 5, 8]) {
    assert.equal(
      h.pixelToLon(z, 3, TILE_SIZE),
      h.pixelToLon(z, 4, 0),
      `z${z}: east edge of tile 3 must equal west edge of tile 4`
    );
    assert.equal(
      h.pixelToLat(z, 3, TILE_SIZE),
      h.pixelToLat(z, 4, 0),
      `z${z}: south edge of tile 3 must equal north edge of tile 4`
    );
  }
});

// --- Palette ----------------------------------------------------------------------

test("palette runs from white at its brightest to near-black at its darkest", () => {
  const brightest = h.colourForSqm(16);
  const darkest = h.colourForSqm(22);

  assert.deepEqual(brightest, [255, 255, 255], "inner city is white");
  assert.ok(
    darkest.every((channel) => channel < 60),
    `pristine sky should be near black, got ${darkest}`
  );
});

test("palette clamps outside its range rather than producing nonsense", () => {
  assert.deepEqual(h.colourForSqm(10), h.colourForSqm(16), "clamped below");
  assert.deepEqual(h.colourForSqm(30), h.colourForSqm(22), "clamped above");
});

test("palette colours are all distinct, so every band is readable", () => {
  // What we can actually guarantee: no two palette stops render the same, so a
  // reader can always tell the bands apart on the map and in the legend.
  const seen = new Set();
  for (const [sqm] of h.PALETTE) {
    const colour = h.colourForSqm(sqm).join(",");
    assert.ok(!seen.has(colour), `SQM ${sqm} duplicates an earlier colour (${colour})`);
    seen.add(colour);
  }
});

test("DOCUMENTED LIMITATION: the classic palette is not perceptually uniform", () => {
  // This test pins a known flaw rather than a desired property, so nobody
  // "fixes" the palette by accident and so the tradeoff stays visible.
  //
  // The classic light-pollution rainbow is NOT monotonic in perceived
  // brightness: yellow (SQM 19.5) is roughly twice as luminant as the red at
  // SQM 17.5 that precedes it. Rainbow scales are widely criticised for exactly
  // this — the eye reads the bright yellow band as a boundary that the
  // underlying data does not contain.
  //
  // It was chosen anyway, deliberately, because it matches Falchi, Lorenz and
  // lightpollutionmap.info, and being directly comparable against the reference
  // maps is worth more here than perceptual purity. Switching to viridis would
  // fix the uniformity and lose the comparability; it is a one-function change
  // if that trade ever looks wrong.
  const luminance = (sqm) => {
    const [r, g, b] = h.colourForSqm(sqm);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  assert.ok(
    luminance(19.5) > luminance(17.5) * 1.5,
    "yellow really is much brighter than red — if this ever fails, the palette " +
      "changed and the comparability tradeoff should be revisited"
  );

  // The endpoints, at least, run the right way round.
  assert.ok(luminance(16) > luminance(22) * 10, "white to near-black overall");
});

test("palette produces a valid colour for every input", () => {
  for (let sqm = 10; sqm <= 30; sqm += 0.25) {
    const colour = h.colourForSqm(sqm);
    assert.equal(colour.length, 3, `SQM ${sqm}`);
    for (const channel of colour) {
      assert.ok(
        Number.isInteger(channel) && channel >= 0 && channel <= 255,
        `SQM ${sqm} produced channel ${channel}`
      );
    }
  }
});

// --- Rendering ---------------------------------------------------------------------

test("renders a valid PNG", { skip: !gridExists }, () => {
  h.tileCache.clear();
  const buffer = tiles.renderTile(7, 32, 47);

  // PNG signature: 0x89 'P' 'N' 'G'
  assert.equal(buffer[0], 0x89);
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");
  assert.ok(buffer.length > 100, "not an empty image");
});

test("a city tile and an ocean tile look different", { skip: !gridExists }, () => {
  // A renderer that ignored the grid entirely would still emit valid PNGs of
  // the right size. Comparing two tiles with genuinely different data is what
  // proves the sampling is connected to the output.
  h.tileCache.clear();
  const chicago = tiles.renderTile(7, 32, 47);
  const pacific = tiles.renderTile(7, 10, 64);

  assert.notEqual(
    chicago.toString("base64"),
    pacific.toString("base64"),
    "Chicago and the mid-Pacific must not render identically"
  );

  // Open ocean is a single uniform colour, so it compresses far better than a
  // city with a full brightness gradient across it.
  assert.ok(
    pacific.length < chicago.length,
    `uniform ocean tile (${pacific.length}B) should compress smaller than ` +
      `a varied city tile (${chicago.length}B)`
  );
});

test("the tile cache returns the identical buffer", { skip: !gridExists }, () => {
  h.tileCache.clear();
  const first = tiles.renderTile(6, 16, 23);
  const second = tiles.renderTile(6, 16, 23);
  assert.equal(first, second, "same object, not merely equal contents");
});

// --- Route -------------------------------------------------------------------------

test("serves a PNG with a long cache lifetime", { skip: !gridExists }, async () => {
  const { status, contentType, cacheControl, buffer } = await call(
    "/api/lightpollution/tile/7/32/47.png"
  );

  assert.equal(status, 200);
  assert.match(contentType, /image\/png/);
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");

  // Tiles derive from a static 2015 dataset and never change, so re-panning
  // over the same area should cost nothing.
  assert.match(cacheControl, /max-age=\d{4,}/, "cached for at least an hour");
  assert.match(cacheControl, /immutable/);
});

test("rejects out-of-range tile coordinates", async () => {
  const cases = [
    [`/api/lightpollution/tile/${MAX_NATIVE_ZOOM + 1}/1/1.png`, "zoom beyond native"],
    ["/api/lightpollution/tile/7/999/47.png", "x beyond 2^z"],
    ["/api/lightpollution/tile/7/32/999.png", "y beyond 2^z"],
    ["/api/lightpollution/tile/abc/1/1.png", "non-numeric zoom"],
    ["/api/lightpollution/tile/-1/0/0.png", "negative zoom"],
  ];

  for (const [urlPath, description] of cases) {
    const { status } = await call(urlPath);
    assert.equal(status, 400, `${description} should be rejected`);
  }
});

test("zoom 0 tile 0/0 is valid — the whole world", { skip: !gridExists }, async () => {
  const { status, buffer } = await call("/api/lightpollution/tile/0/0/0.png");
  assert.equal(status, 200);
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");
});

test("the legend is generated from the same palette the tiles use", async () => {
  const { status, buffer } = await call("/api/lightpollution/tile/legend");
  assert.equal(status, 200);

  const body = JSON.parse(buffer.toString());
  assert.equal(body.stops.length, h.PALETTE.length, "one stop per palette entry");
  assert.equal(body.maxNativeZoom, MAX_NATIVE_ZOOM);
  assert.match(body.license, /CC BY-NC/, "attribution travels with the legend");

  // Each legend colour must be exactly what the renderer would draw for that
  // SQM value. If these could drift, the key would be quietly lying.
  for (const stop of body.stops) {
    const [r, g, b] = h.colourForSqm(stop.sqm);
    assert.equal(stop.colour, `rgb(${r}, ${g}, ${b})`, `legend colour at SQM ${stop.sqm}`);
  }
});
