// LightMatter — cloud cover route
//
// Thin HTTP wrapper; data logic lives in ../sources/clouds.js.

const express = require("express");
const { getClouds } = require("../sources/clouds");
const { validateCoordinates } = require("./validate");

const router = express.Router();

router.get("/", async (req, res) => {
  const coords = validateCoordinates(req.query);
  if (coords.error) return res.status(400).json({ error: coords.error });

  try {
    res.json(await getClouds(coords.lat, coords.lon));
  } catch (err) {
    res
      .status(err.statusCode || 502)
      .json({ error: "Could not fetch cloud data", detail: err.message });
  }
});

module.exports = router;
