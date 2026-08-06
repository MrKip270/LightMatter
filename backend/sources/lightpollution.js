// LightMatter — light pollution data source
//
// Unlike aurora and clouds, this calls no external API. The downsampled World
// Atlas grid (see tools/build-lightpollution.js) is loaded into memory once at
// startup and every lookup is array index math — no network, no database.
//
// Dataset is CC BY-NC 4.0 (NonCommercial). Attribution is returned in every
// response. Swapping datasets means replacing the .bin file, not editing this
// module: the geometry is read from the file's own header.

const fs = require("fs");
const path = require("path");

const GRID_PATH = path.join(__dirname, "..", "data", "lightpollution.bin");

const NATURAL_MCD = 0.171168465; // 22.00 mag/arcsec^2 in mcd/m^2

let grid = null;
let meta = null;
let loadError = null;

// Load once, at module load. If it fails we record why and let callers report
// "unavailable" — a fresh clone that hasn't run the build tool should still
// serve aurora and clouds.
try {
  const buffer = fs.readFileSync(GRID_PATH);

  // Header layout: [uint32 length][JSON of that length][uint16 grid data]
  const headerLength = buffer.readUInt32LE(0);
  meta = JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8"));

  // Uint16Array requires its byteOffset to be a multiple of 2, and the header
  // length is arbitrary. Copying sidesteps the alignment rule entirely.
  const dataBytes = Uint8Array.prototype.slice.call(buffer, 4 + headerLength);
  grid = new Uint16Array(dataBytes.buffer);

  if (grid.length !== meta.width * meta.height) {
    throw new Error(
      `grid size mismatch: header says ${meta.width}x${meta.height} ` +
        `but file holds ${grid.length} cells`
    );
  }
} catch (err) {
  loadError =
    err.code === "ENOENT"
      ? "Light pollution grid not built. Run: node tools/build-lightpollution.js <World_Atlas_2015.tif>"
      : `Could not load light pollution grid: ${err.message}`;
}

// --- Pure helpers -------------------------------------------------------------

// Naked-eye limiting magnitude: the faintest star visible from this sky.
// More useful to a beginner than SQM, because it answers "how many stars".
// Formula from Unihedron, via lightpollutionmap.info FAQ #31.
function nakedEyeLimitingMagnitude(sqm) {
  return 7.93 - 5 * Math.log10(Math.pow(10, 4.316 - sqm / 5) + 1);
}

// Cumulative naked-eye star counts over the WHOLE celestial sphere, by limiting
// magnitude. Standard astronomical figures — each step of one magnitude roughly
// triples the count, which is why a small change in sky brightness produces a
// dramatic change in how many stars you see.
const STAR_COUNTS = [
  [0, 4],
  [1, 15],
  [2, 48],
  [3, 171],
  [4, 513],
  [5, 1602],
  [6, 4800],
  [6.5, 9100],
  [7, 14000],
];

// Fraction of the whole-sky count actually visible at one moment. Half the
// sphere is below the horizon, and atmospheric extinction near the horizon
// costs another chunk — stars low in the sky are dimmed by the longer air path.
// 0.30 calibrates against the commonly cited "about 2,500-3,000 stars visible to
// the naked eye under ideal conditions."
const VISIBLE_AT_ONCE_FRACTION = 0.3;

// Estimated number of stars visible at once for a given limiting magnitude.
//
// Interpolated in LOG space, because star counts grow geometrically with
// magnitude. Linear interpolation between 4,800 and 9,100 would badly
// misestimate the middle.
function visibleStarCount(limitingMagnitude) {
  const m = Math.min(7, Math.max(0, limitingMagnitude));

  let lower = STAR_COUNTS[0];
  let upper = STAR_COUNTS[STAR_COUNTS.length - 1];
  for (let i = 0; i < STAR_COUNTS.length - 1; i++) {
    if (m >= STAR_COUNTS[i][0] && m <= STAR_COUNTS[i + 1][0]) {
      lower = STAR_COUNTS[i];
      upper = STAR_COUNTS[i + 1];
      break;
    }
  }

  const span = upper[0] - lower[0];
  const t = span === 0 ? 0 : (m - lower[0]) / span;
  const whole = Math.pow(
    10,
    Math.log10(lower[1]) + t * (Math.log10(upper[1]) - Math.log10(lower[1]))
  );

  return Math.round(whole * VISIBLE_AT_ONCE_FRACTION);
}

// Plain-language description. Deliberately NOT the Bortle scale: Bortle is a
// subjective whole-sky visual assessment, while this dataset models brightness
// at the zenith only. Both the atlas authors and David Lorenz explicitly ask
// people not to conflate the two.
function describeSky(sqm) {
  if (sqm >= 21.75) return "Pristine dark sky";
  if (sqm >= 21.3) return "Rural";
  if (sqm >= 20.5) return "Rural / suburban edge";
  if (sqm >= 19.5) return "Suburban";
  if (sqm >= 18.5) return "Bright suburban";
  if (sqm >= 17.5) return "Urban";
  return "Inner city";
}

// What that means for someone standing outside.
//
// Note the asymmetry between target types. Skyglow works by raising the
// background, which destroys CONTRAST — so diffuse, extended objects (the Milky
// Way, nebulae) wash out almost immediately, while bright point sources punch
// straight through. Jupiter at magnitude -2.9 sits ~6 magnitudes above an
// inner-city limit of 3.2, a factor of about 250 in brightness. That is why the
// bottom tier still promises planets while the tier above has given up on the
// Milky Way.
//
// "Brightest planets" is deliberate: Venus, Jupiter, Mars and Saturn clear the
// limit easily, but Mercury sits low in twilight where atmospheric extinction
// costs it 1-3 magnitudes, and Uranus (+5.4) and Neptune (+7.8) are not
// naked-eye objects under ANY sky.
function visibilityNote(sqm) {
  if (sqm >= 21.3) return "Milky Way clearly visible; faint objects within reach.";
  if (sqm >= 20.5) return "Milky Way visible but washed out near the horizon.";
  if (sqm >= 19.5) return "Milky Way barely detectable; brighter constellations clear.";
  if (sqm >= 18.5) return "Milky Way not visible; only brighter stars stand out.";
  return "Only the Moon, the brightest planets, and a few dozen stars are visible.";
}

// Look up a coordinate. Returns null outside the dataset extent (85.05N to 60S)
// or where there is no reading.
function lookup(lat, lon) {
  const col = Math.floor((lon - meta.originX) / meta.resX);
  const row = Math.floor((lat - meta.originY) / meta.resY); // resY is negative

  if (col < 0 || col >= meta.width || row < 0 || row >= meta.height) return null;

  const raw = grid[row * meta.width + col];
  if (raw === meta.noData) return null;

  return raw / meta.scale;
}

// --- The source --------------------------------------------------------------

function getLightPollution(lat, lon) {
  if (loadError) {
    const err = new Error(loadError);
    err.statusCode = 503; // our problem, not the caller's
    throw err;
  }

  const sqm = lookup(lat, lon);
  const attribution = `${meta.source} — ${meta.license}`;

  // Outside the atlas extent. The request worked, there is simply no reading.
  if (sqm === null) {
    return {
      source: meta.source,
      dataAvailable: false,
      location: { lat, lon },
      visibility:
        "No light pollution data for this location (the atlas covers 85N to 60S).",
      sqm: null,
      sky: null,
      nakedEyeLimitingMagnitude: null,
      attribution,
    };
  }

  return {
    source: meta.source,
    dataAvailable: true,
    location: { lat, lon },
    sqm: Number(sqm.toFixed(2)),
    sky: describeSky(sqm),
    visibility: visibilityNote(sqm),
    nakedEyeLimitingMagnitude: Number(nakedEyeLimitingMagnitude(sqm).toFixed(1)),
    // Honesty about vintage: 2015 observations. Light pollution has generally
    // increased since, so real skies are usually a little brighter than this.
    dataYear: meta.dataYear,
    resolutionKm: Number((meta.resX * 111).toFixed(1)),
    attribution,
  };
}

module.exports = {
  getLightPollution,
  helpers: {
    nakedEyeLimitingMagnitude,
    visibleStarCount,
    describeSky,
    visibilityNote,
    NATURAL_MCD,
    STAR_COUNTS,
    VISIBLE_AT_ONCE_FRACTION,
  },
};
