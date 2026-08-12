// LightMatter — light pollution tile route
//
//   GET /api/lightpollution/tile/:z/:x/:y.png   -> a 256x256 PNG tile
//   GET /api/lightpollution/legend              -> palette stops for the key
//
// Thin HTTP wrapper; rendering lives in ../sources/lightpollutiontiles.js.

const express = require("express");
const {
  renderTile,
  legend,
  MAX_NATIVE_ZOOM,
  TILE_SIZE,
} = require("../sources/lightpollutiontiles");

const router = express.Router();

// The legend is generated from the same palette the tiles use, so the key can
// never drift out of sync with what's drawn on the map.
router.get("/legend", (req, res) => {
  res.json({
    stops: legend(),
    units: "magnitudes per square arc-second (SQM); higher is darker",
    maxNativeZoom: MAX_NATIVE_ZOOM,
    tileSize: TILE_SIZE,
    source: "Falchi et al. 2016, World Atlas of Artificial Night Sky Brightness",
    license: "CC BY-NC 4.0",
  });
});

router.get("/:z/:x/:y.png", (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  // Validate before rendering. At zoom z the world is a 2^z by 2^z grid, so
  // anything outside that is a malformed request — and without this check a
  // huge z would try to allocate an absurd tile index.
  const maxIndex = Math.pow(2, z);
  if (
    !Number.isInteger(z) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    z < 0 ||
    z > MAX_NATIVE_ZOOM ||
    x < 0 ||
    x >= maxIndex ||
    y < 0 ||
    y >= maxIndex
  ) {
    return res.status(400).json({
      error: `Tile out of range. z must be 0..${MAX_NATIVE_ZOOM}, and x/y must be 0..2^z-1.`,
    });
  }

  try {
    const png = renderTile(z, x, y);

    // Tiles are derived from a static 2015 dataset, so they never change. A
    // long cache lifetime means a browser re-panning over the same area does
    // not re-request anything at all.
    res.set({
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, immutable",
    });
    res.send(png);
  } catch (err) {
    res
      .status(err.statusCode || 500)
      .json({ error: "Could not render tile", detail: err.message });
  }
});

module.exports = router;
