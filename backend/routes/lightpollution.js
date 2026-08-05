// LightMatter — light pollution route
//
// Thin HTTP wrapper; data logic lives in ../sources/lightpollution.js.

const express = require("express");
const { getLightPollution } = require("../sources/lightpollution");
const { validateCoordinates } = require("./validate");

const router = express.Router();

router.get("/", (req, res) => {
  const coords = validateCoordinates(req.query);
  if (coords.error) return res.status(400).json({ error: coords.error });

  try {
    res.json(getLightPollution(coords.lat, coords.lon));
  } catch (err) {
    // 503 when the grid failed to load — that is our problem, not the
    // caller's, and it is fixed by running the build tool.
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
