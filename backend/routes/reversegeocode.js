// LightMatter — reverse geocoding route
//
// Thin HTTP wrapper; data logic lives in ../sources/reversegeocode.js.
//
//   GET /api/reverse-geocode?lat=41.66&lon=-77.81
//   -> { label: "Coudersport, Pennsylvania, United States", ... }

const express = require("express");
const { reverseGeocode } = require("../sources/reversegeocode");
const { validateCoordinates } = require("./validate");

const router = express.Router();

router.get("/", async (req, res) => {
  const coords = validateCoordinates(req.query);
  if (coords.error) return res.status(400).json({ error: coords.error });

  try {
    res.json(await reverseGeocode(coords.lat, coords.lon));
  } catch (err) {
    // A naming failure must never block a sky report — the coordinates are all
    // the rest of the app actually needs. So this degrades to a 200 with no
    // label rather than an error status, and the map falls back to showing raw
    // coordinates. Failing loudly here would turn a cosmetic problem into a
    // broken feature.
    res.json({
      source: "OpenStreetMap Nominatim",
      dataAvailable: false,
      location: { lat: coords.lat, lon: coords.lon },
      label: null,
      detail: err.message,
      attribution: "© OpenStreetMap contributors",
    });
  }
});

module.exports = router;
