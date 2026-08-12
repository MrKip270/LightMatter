// LightMatter — light pollution map tiles
//
// Renders 256x256 PNG tiles from the in-memory light pollution grid, in the
// standard slippy-map scheme Leaflet expects.
//
// WHY TILES RATHER THAN ONE BIG IMAGE
// The grid is stored in EPSG:4326 (equirectangular — equal degrees per pixel).
// Leaflet renders in EPSG:3857 (Web Mercator — equal *projected* metres per
// pixel, which stretches enormously toward the poles). Dropping the raw grid on
// as an L.imageOverlay maps corner to corner LINEARLY in projected space, so
// everything between the corners lands in the wrong place: the tropics
// compressed, Scandinavia and Canada squashed poleward, errors of hundreds of
// kilometres exactly where the dark-sky sites are.
//
// Tiles avoid this by construction. Each tile's bounds are defined in Mercator,
// so we convert per pixel and sample the grid at the true latitude/longitude.
// The projection maths is done once, here, and cannot silently drift.

const { PNG } = require("pngjs");
const { grid, meta, loadError } = require("./lightpollutiongrid");

const TILE_SIZE = 256;

// The grid is 4 arcmin (~7 km) per cell, so past roughly zoom 8 a tile is
// sampling the same handful of cells over and over. Leaflet is told to stop
// requesting new tiles beyond this and upscale instead, which is honest: it
// shows the data getting blurry rather than inventing crisp detail.
const MAX_NATIVE_ZOOM = 8;

// --- Palette -------------------------------------------------------------------
// The classic light-pollution colour scheme used by Falchi, Lorenz and
// lightpollutionmap.info, so this map can be compared against them.
//
// Stops are [SQM, r, g, b]. Ordered BRIGHTEST sky first (low SQM = worst light
// pollution) so the array reads in the same direction as the legend.
const PALETTE = [
  [16.0, 255, 255, 255], // white — inner city
  [17.5, 255, 80, 80], //  red
  [18.5, 255, 160, 60], //  orange
  [19.5, 255, 235, 90], //  yellow
  [20.5, 110, 210, 110], // green
  [21.3, 70, 130, 220], //  blue
  [21.75, 30, 50, 120], //  deep blue
  [22.0, 8, 10, 30], //     near black — pristine
];

// Precomputed colour lookup, indexed by SQM in hundredths from 16.00 to 22.00.
// Filled lazily on first use.
//
// Interpolating per pixel meant walking the palette 65,536 times per tile. The
// interesting SQM range spans only 600 hundredth-steps, so precomputing every
// possible answer once turns the inner loop into a single array index.
const COLOUR_LUT_MIN = 1600;
const COLOUR_LUT_MAX = 2200;
let colourLut = null;

function buildColourLut() {
  const lut = new Uint8Array((COLOUR_LUT_MAX - COLOUR_LUT_MIN + 1) * 3);
  for (let i = COLOUR_LUT_MIN; i <= COLOUR_LUT_MAX; i++) {
    const [r, g, b] = colourForSqm(i / 100);
    const offset = (i - COLOUR_LUT_MIN) * 3;
    lut[offset] = r;
    lut[offset + 1] = g;
    lut[offset + 2] = b;
  }
  return lut;
}

// Interpolate a colour for an SQM value.
//
// Interpolating in RGB is not perceptually ideal, but it matches how the
// reference maps are drawn, and matching them is the point of choosing this
// palette. A perceptual scale would look better and compare worse.
function colourForSqm(sqm) {
  if (sqm <= PALETTE[0][0]) return PALETTE[0].slice(1);
  const last = PALETTE[PALETTE.length - 1];
  if (sqm >= last[0]) return last.slice(1);

  for (let i = 0; i < PALETTE.length - 1; i++) {
    const [lowSqm, lr, lg, lb] = PALETTE[i];
    const [highSqm, hr, hg, hb] = PALETTE[i + 1];
    if (sqm >= lowSqm && sqm <= highSqm) {
      const t = (sqm - lowSqm) / (highSqm - lowSqm);
      return [
        Math.round(lr + t * (hr - lr)),
        Math.round(lg + t * (hg - lg)),
        Math.round(lb + t * (hb - lb)),
      ];
    }
  }
  return last.slice(1);
}

// --- Slippy-map projection -----------------------------------------------------
// The standard scheme: at zoom z the world is a 2^z by 2^z grid of tiles,
// x increasing east from -180, y increasing SOUTH from the top.

// Pixel column within a tile -> longitude. Linear, because Mercator does not
// distort longitude at all.
function pixelToLon(z, tileX, pixelX) {
  return ((tileX + pixelX / TILE_SIZE) / Math.pow(2, z)) * 360 - 180;
}

// Pixel row -> latitude. This is the inverse Mercator projection, and it is
// where all the non-linearity lives: equal pixel steps are much larger
// latitude steps near the equator than near the poles.
function pixelToLat(z, tileY, pixelY) {
  const n = Math.PI - (2 * Math.PI * (tileY + pixelY / TILE_SIZE)) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

// Which tile contains a coordinate. Only used by tests, but it lives here so
// the forward and inverse transforms stay side by side and can be checked
// against each other.
function tileForCoords(lat, lon, z) {
  const n = Math.pow(2, z);
  const latRad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    ),
  };
}

// --- Grid sampling ---------------------------------------------------------------

function sampleSqm(lat, lon) {
  const col = Math.floor((lon - meta.originX) / meta.resX);
  const row = Math.floor((lat - meta.originY) / meta.resY); // resY is negative
  if (col < 0 || col >= meta.width || row < 0 || row >= meta.height) return null;
  const raw = grid[row * meta.width + col];
  return raw === meta.noData ? null : raw / meta.scale;
}

// --- Tile cache -----------------------------------------------------------------
// Encoding is only ~5ms, but a single map view requests a dozen tiles and
// panning re-requests neighbours constantly. Caching the encoded buffers makes
// repeat views free.
const tileCache = new Map();
const TILE_CACHE_LIMIT = 2000; // ~2 MB of PNG at typical tile sizes

// --- Rendering --------------------------------------------------------------------

function renderTile(z, x, y) {
  if (loadError) {
    const err = new Error(loadError);
    err.statusCode = 503;
    throw err;
  }

  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);

  if (!colourLut) colourLut = buildColourLut();

  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  const data = png.data;

  // Hoist everything that does not vary per pixel out of the inner loop.
  //
  // A tile is 65,536 pixels, but there are only 256 distinct longitudes and 256
  // distinct latitudes in it. Computing the grid column for every pixel meant
  // doing the same 256 divisions 256 times each. Precomputing both axes turns
  // the inner loop into two array reads and a lookup — the difference between
  // ~78ms and single-digit milliseconds per tile.
  const gridCols = new Int32Array(TILE_SIZE);
  for (let pixelX = 0; pixelX < TILE_SIZE; pixelX++) {
    const lon = pixelToLon(z, x, pixelX);
    const col = Math.floor((lon - meta.originX) / meta.resX);
    gridCols[pixelX] = col >= 0 && col < meta.width ? col : -1;
  }

  const gridRows = new Int32Array(TILE_SIZE);
  for (let pixelY = 0; pixelY < TILE_SIZE; pixelY++) {
    const lat = pixelToLat(z, y, pixelY);
    const row = Math.floor((lat - meta.originY) / meta.resY); // resY is negative
    gridRows[pixelY] = row >= 0 && row < meta.height ? row : -1;
  }

  for (let pixelY = 0; pixelY < TILE_SIZE; pixelY++) {
    const row = gridRows[pixelY];
    const rowOffset = row * meta.width;

    for (let pixelX = 0; pixelX < TILE_SIZE; pixelX++) {
      const col = gridCols[pixelX];
      const offset = (pixelY * TILE_SIZE + pixelX) << 2;

      // Outside the atlas (beyond 85N / 60S, or an out-of-range column).
      // Fully transparent, so the base map shows through cleanly rather than
      // being covered by a block that would imply we have data saying
      // "nothing here". PNG buffers start zeroed, so alpha is already 0.
      if (row < 0 || col < 0) continue;

      const raw = grid[rowOffset + col];
      if (raw === meta.noData) continue;

      const lutOffset =
        (Math.min(COLOUR_LUT_MAX, Math.max(COLOUR_LUT_MIN, Math.round((raw / meta.scale) * 100))) -
          COLOUR_LUT_MIN) * 3;

      data[offset] = colourLut[lutOffset];
      data[offset + 1] = colourLut[lutOffset + 1];
      data[offset + 2] = colourLut[lutOffset + 2];
      // Opaque in the tile itself. Blending against the base map is the
      // frontend's job via layer opacity, so the user can adjust it live
      // without us re-rendering anything.
      data[offset + 3] = 255;
    }
  }

  const buffer = PNG.sync.write(png);

  // Naive LRU: Map preserves insertion order, so the first key is the oldest.
  if (tileCache.size >= TILE_CACHE_LIMIT) {
    tileCache.delete(tileCache.keys().next().value);
  }
  tileCache.set(key, buffer);

  return buffer;
}

// Legend data for the frontend, so the colours in the key are generated from
// the SAME palette the tiles use and cannot drift out of sync with them.
function legend() {
  return PALETTE.map(([sqm, r, g, b]) => ({
    sqm,
    colour: `rgb(${r}, ${g}, ${b})`,
  }));
}

module.exports = {
  renderTile,
  legend,
  MAX_NATIVE_ZOOM,
  TILE_SIZE,
  helpers: {
    colourForSqm,
    pixelToLat,
    pixelToLon,
    tileForCoords,
    sampleSqm,
    tileCache,
    PALETTE,
  },
};
