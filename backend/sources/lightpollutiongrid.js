// LightMatter — light pollution grid loader
//
// Loads the preprocessed grid (see tools/build-lightpollution.js) into memory
// once, at startup, and shares it with every consumer.
//
// This exists as its own module for a specific reason: BOTH the point lookup
// (sources/lightpollution.js) and the tile renderer
// (sources/lightpollutiontiles.js) need the grid. Node caches modules, so
// requiring this from both places yields the same 23 MB buffer rather than two
// copies — and there is exactly one piece of code that knows the file format.
//
// The dataset is CC BY-NC 4.0 (NonCommercial). Geometry is read from the file's
// own header rather than hardcoded, so a newer or differently-licensed grid can
// be swapped in without touching any code.

const fs = require("fs");
const path = require("path");

// Overridable via env var so a spawned child process can test the
// missing/corrupt-file branches below without touching the real 23 MB grid —
// defaults to today's exact path, so nothing changes for every normal run.
const GRID_PATH =
  process.env.LIGHTPOLLUTION_GRID_PATH || path.join(__dirname, "..", "data", "lightpollution.bin");

let grid = null;
let meta = null;
let loadError = null;

// If loading fails we record why rather than throwing. A fresh clone that has
// not run the build tool should still serve clouds, aurora and moon.
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

module.exports = { grid, meta, loadError, GRID_PATH };
