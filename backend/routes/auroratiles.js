// LightMatter — aurora tile route
//
//   GET /api/aurora/tile/:z/:x/:y.png   -> a 256x256 PNG tile
//   GET /api/aurora/tile/legend         -> palette stops + forecast timestamp
//
// Thin HTTP wrapper; rendering and the NOAA grid cache live in
// ../sources/auroratiles.js.

const express = require("express");
const { renderTile, legend, MAX_NATIVE_ZOOM } = require("../sources/auroratiles");

const router = express.Router();

router.get("/legend", async (req, res) => {
  try {
    res.json({
      ...(await legend()),
      units: "percent probability of visible aurora",
      maxNativeZoom: MAX_NATIVE_ZOOM,
      source: "NOAA SWPC OVATION",
    });
  } catch (err) {
    res.status(502).json({ error: "Could not fetch aurora data", detail: err.message });
  }
});

router.get("/:z/:x/:y.png", async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

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
    const png = await renderTile(z, x, y);

    // Short-lived, unlike the light-pollution atlas's immutable caching —
    // this data is genuinely live and refreshes every few minutes.
    res.set({
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
    });
    res.send(png);
  } catch (err) {
    res
      .status(err.statusCode || 500)
      .json({ error: "Could not render tile", detail: err.message });
  }
});

module.exports = router;
