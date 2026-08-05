// LightMatter — moon route
//
// Thin HTTP wrapper; data logic lives in ../sources/moon.js.
// Computed locally, so this never fails for network reasons.

const express = require("express");
const { getMoon } = require("../sources/moon");
const { validateCoordinates } = require("./validate");

const router = express.Router();

router.get("/", (req, res) => {
  const coords = validateCoordinates(req.query);
  if (coords.error) return res.status(400).json({ error: coords.error });

  // Optional ?date=YYYY-MM-DD for looking ahead. Everything here is computed
  // from orbital mechanics rather than a forecast, so any date works — which is
  // the groundwork for the PRD's future-date feature.
  const at = req.query.date ? new Date(req.query.date) : new Date();
  if (Number.isNaN(at.getTime())) {
    return res.status(400).json({ error: "date must be a valid date, e.g. 2026-08-28" });
  }

  try {
    res.json(getMoon(coords.lat, coords.lon, at));
  } catch (err) {
    res.status(500).json({ error: "Could not compute moon data", detail: err.message });
  }
});

module.exports = router;
