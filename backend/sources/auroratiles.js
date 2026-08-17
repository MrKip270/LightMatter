// LightMatter — aurora map tiles
//
// Renders 256x256 PNG tiles from NOAA SWPC's OVATION aurora probability grid,
// in the same slippy-map scheme lightpollutiontiles.js uses.
//
// WHY THIS IS ITS OWN GRID, SEPARATE FROM sources/aurora.js
// aurora.js does one NOAA fetch per /api/aurora request and looks up a single
// cell — fine for a point query, wasteful for a map view that requests a
// dozen tiles at once. This module fetches the WHOLE grid once and holds it
// in memory for a short TTL, so a pan/zoom that fires many tile requests
// costs NOAA exactly one fetch. The two never share code: /api/aurora's
// behaviour is out of scope for the map layer and must not change.
//
// WHY IT'S SIMPLER THAN THE LIGHT-POLLUTION GRID
// OVATION is a full, regular 1x1 degree grid — 360 longitudes x 181
// latitudes, every cell present, verified empirically (65,160 = 360x181, no
// gaps, no no-data sentinel). There's no header to parse, no missing-coverage
// band, and no "outside the dataset" case to handle: the grid covers the
// whole globe. Bilinear interpolation here is a direct blend of the four
// surrounding INTEGER-DEGREE SAMPLES (grid nodes, not cell corners) — unlike
// the light-pollution grid, no -0.5 shift is needed.

const { PNG } = require("pngjs");

const NOAA_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
const TILE_SIZE = 256;

// The grid is ~111 km per cell at the equator — about 16x coarser than the
// light pollution atlas's ~7 km cells (that atlas caps native zoom at 8).
// Halving the tile's degree span each zoom level doubles resolution, so 4
// fewer zoom levels (2^4 = 16) matches the coarseness ratio directly rather
// than guessing a number.
const MAX_NATIVE_ZOOM = 4;

const WIDTH = 360; // longitude 0..359, one sample per degree
const HEIGHT = 181; // latitude -90..90 inclusive, one sample per degree

// NOAA's grid refreshes every few minutes; re-fetching that often keeps the
// overlay honestly "live" without hammering their service on every tile.
const GRID_TTL_MS = 5 * 60 * 1000;

// --- Palette ---------------------------------------------------------------
// Unlike the light-pollution palette (opaque tiles, blended by LAYER
// opacity), probability drives per-pixel ALPHA directly: 0% is fully
// transparent so the base map shows through with no implication that "we
// checked here and found nothing unusual", rising to a saturated aurora
// green — 557.7 nm oxygen emission is the colour most real aurora displays
// are dominated by — at the high end.
//
// Stops are [probability 0-100, r, g, b, a].
const PALETTE = [
  [0, 20, 180, 90, 0],
  [10, 20, 180, 90, 60],
  [35, 60, 230, 120, 140],
  [65, 110, 255, 150, 200],
  [100, 190, 255, 210, 255],
];

// Precomputed colour+alpha lookup, indexed by probability 0-100. The range is
// tiny (101 entries) compared to light pollution's LUT, but the technique —
// walk the palette once, index the rest — is the same: it turns per-pixel
// interpolation into a single array read.
let colourLut = null;

function buildColourLut() {
  const lut = new Uint8Array(101 * 4);
  for (let p = 0; p <= 100; p++) {
    const [r, g, b, a] = colourForProbability(p);
    const offset = p * 4;
    lut[offset] = r;
    lut[offset + 1] = g;
    lut[offset + 2] = b;
    lut[offset + 3] = a;
  }
  return lut;
}

function colourForProbability(p) {
  if (p <= PALETTE[0][0]) return PALETTE[0].slice(1);
  const last = PALETTE[PALETTE.length - 1];
  if (p >= last[0]) return last.slice(1);

  for (let i = 0; i < PALETTE.length - 1; i++) {
    const [loP, lr, lg, lb, la] = PALETTE[i];
    const [hiP, hr, hg, hb, ha] = PALETTE[i + 1];
    if (p >= loP && p <= hiP) {
      const t = (p - loP) / (hiP - loP);
      return [
        Math.round(lr + t * (hr - lr)),
        Math.round(lg + t * (hg - lg)),
        Math.round(lb + t * (hb - lb)),
        Math.round(la + t * (ha - la)),
      ];
    }
  }
  return last.slice(1);
}

// --- Slippy-map projection --------------------------------------------------
// Identical maths to lightpollutiontiles.js — the projection is a property of
// the map, not the dataset, so it's worth keeping the two in step rather than
// sharing a module for two lines of arithmetic.

function pixelToLon(z, tileX, pixelX) {
  return ((tileX + pixelX / TILE_SIZE) / Math.pow(2, z)) * 360 - 180;
}

function pixelToLat(z, tileY, pixelY) {
  const n = Math.PI - (2 * Math.PI * (tileY + pixelY / TILE_SIZE)) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

// --- NOAA grid fetch + cache -------------------------------------------------

let grid = null; // Uint8Array(WIDTH * HEIGHT), probability 0-100
let observationTime = null;
let forecastTime = null;
let fetchedAt = 0;
let inFlight = null;

async function refresh() {
  const response = await fetch(NOAA_URL);
  if (!response.ok) {
    throw new Error(`NOAA responded with status ${response.status}`);
  }
  const data = await response.json();

  const next = new Uint8Array(WIDTH * HEIGHT);
  for (const [lon, lat, prob] of data.coordinates) {
    const row = lat + 90;
    const col = ((lon % 360) + 360) % 360;
    next[row * WIDTH + col] = prob;
  }

  grid = next;
  observationTime = data["Observation Time"];
  forecastTime = data["Forecast Time"];
  fetchedAt = Date.now();
  tileCache.clear(); // the data just changed; every cached tile is stale
}

// Ensures the grid is no older than GRID_TTL_MS, fetching if needed.
// Concurrent callers (a single map view can request a dozen tiles at once)
// share one in-flight fetch instead of each firing their own request at
// NOAA. A failed fetch does NOT throw here — it leaves whatever grid we
// already have in place (stale-but-real beats nothing), matching the site's
// rule that one dead source must not break what was already rendering.
async function ensureFresh() {
  const isStale = Date.now() - fetchedAt > GRID_TTL_MS;
  if (grid && !isStale) return;
  if (!inFlight) {
    inFlight = refresh()
      .catch(() => {
        // Swallowed deliberately: renderTile() below falls back to a blank
        // tile when grid is still null, and keeps serving the old grid when
        // it isn't. Either way a slow/unreachable NOAA must not surface as a
        // broken map tile.
      })
      .finally(() => {
        inFlight = null;
      });
  }
  await inFlight;
}

// --- Rendering ---------------------------------------------------------------

const tileCache = new Map();
const TILE_CACHE_LIMIT = 400; // see lightpollutiontiles.js for the sizing note

let blankTile = null;
function getBlankTile() {
  if (!blankTile) {
    blankTile = PNG.sync.write(new PNG({ width: TILE_SIZE, height: TILE_SIZE }));
  }
  return blankTile;
}

async function renderTile(z, x, y) {
  await ensureFresh();

  // Never fetched successfully (fresh clone, or NOAA unreachable on first
  // request): nothing to draw. A transparent tile, not an error, so the base
  // map still renders cleanly underneath.
  if (!grid) return getBlankTile();

  const key = `${z}/${x}/${y}/${fetchedAt}`;
  if (tileCache.has(key)) return tileCache.get(key);

  if (!colourLut) colourLut = buildColourLut();

  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  const data = png.data;

  // Hoist the per-axis maths out of the pixel loop — see
  // lightpollutiontiles.js for why this matters (78ms -> 8ms there).
  const col0 = new Int32Array(TILE_SIZE);
  const col1 = new Int32Array(TILE_SIZE);
  const colT = new Float32Array(TILE_SIZE);

  for (let pixelX = 0; pixelX < TILE_SIZE; pixelX++) {
    const lon = pixelToLon(z, x, pixelX);
    const exact = ((lon % 360) + 360) % 360; // grid nodes sit at integer degrees
    const base = Math.floor(exact);
    colT[pixelX] = exact - base;
    col0[pixelX] = base % WIDTH;
    col1[pixelX] = (base + 1) % WIDTH; // longitude wraps around the globe
  }

  const row0 = new Int32Array(TILE_SIZE);
  const row1 = new Int32Array(TILE_SIZE);
  const rowT = new Float32Array(TILE_SIZE);

  for (let pixelY = 0; pixelY < TILE_SIZE; pixelY++) {
    const lat = pixelToLat(z, y, pixelY);
    const exact = lat + 90;
    // Clamp rather than wrap: latitude has ends, not seams. Mercator's own
    // asymptote keeps `lat` just short of +-90, so this only ever trims by a
    // hair at the poles.
    const base = Math.min(HEIGHT - 2, Math.max(0, Math.floor(exact)));
    rowT[pixelY] = exact - base;
    row0[pixelY] = base;
    row1[pixelY] = base + 1;
  }

  for (let pixelY = 0; pixelY < TILE_SIZE; pixelY++) {
    const rowA = row0[pixelY] * WIDTH;
    const rowB = row1[pixelY] * WIDTH;
    const ty = rowT[pixelY];

    for (let pixelX = 0; pixelX < TILE_SIZE; pixelX++) {
      const tx = colT[pixelX];
      const cA = col0[pixelX];
      const cB = col1[pixelX];

      const probability =
        grid[rowA + cA] * (1 - tx) * (1 - ty) +
        grid[rowA + cB] * tx * (1 - ty) +
        grid[rowB + cA] * (1 - tx) * ty +
        grid[rowB + cB] * tx * ty;

      const lutOffset = Math.round(Math.min(100, Math.max(0, probability))) * 4;

      const offset = (pixelY * TILE_SIZE + pixelX) << 2;
      data[offset] = colourLut[lutOffset];
      data[offset + 1] = colourLut[lutOffset + 1];
      data[offset + 2] = colourLut[lutOffset + 2];
      data[offset + 3] = colourLut[lutOffset + 3];
    }
  }

  const buffer = PNG.sync.write(png);

  if (tileCache.size >= TILE_CACHE_LIMIT) {
    tileCache.delete(tileCache.keys().next().value);
  }
  tileCache.set(key, buffer);

  return buffer;
}

// Legend + timestamp for the frontend, generated from the same palette and
// grid the tiles use so neither can drift out of sync with what's drawn.
async function legend() {
  await ensureFresh();
  return {
    stops: PALETTE.map(([probability, r, g, b, a]) => ({
      probability,
      colour: `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`,
    })),
    observationTime,
    forecastTime,
  };
}

module.exports = {
  renderTile,
  legend,
  MAX_NATIVE_ZOOM,
  TILE_SIZE,
  helpers: {
    colourForProbability,
    pixelToLat,
    pixelToLon,
    tileCache,
    PALETTE,
    WIDTH,
    HEIGHT,
    // Test-only seam: lets tests install a known grid without a real NOAA
    // fetch. Never used by production code paths.
    _setGridForTests(nextGrid, obsTime, forTime) {
      grid = nextGrid;
      observationTime = obsTime;
      forecastTime = forTime;
      fetchedAt = Date.now();
      tileCache.clear();
    },
    _reset() {
      grid = null;
      observationTime = null;
      forecastTime = null;
      fetchedAt = 0;
      inFlight = null;
      tileCache.clear();
    },
  },
};
