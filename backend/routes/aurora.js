// LightMatter — aurora route
//
// Thin HTTP wrapper. All the data logic lives in ../sources/aurora.js so that
// /api/sky can reuse it directly instead of making an HTTP call to this route.
// This file's only jobs are: read the query string, validate it, and translate
// success or failure into a status code.

const express = require("express");
const { getAurora } = require("../sources/aurora");
const { validateCoordinates } = require("./validate");

const router = express.Router();

router.get("/", async (req, res) => {
  const coords = validateCoordinates(req.query);
  if (coords.error) return res.status(400).json({ error: coords.error });

  try {
    res.json(await getAurora(coords.lat, coords.lon));
  } catch (err) {
    // Resilience (PRD): one dead source must not crash the server.
    res
      .status(err.statusCode || 502)
      .json({ error: "Could not fetch aurora data", detail: err.message });
  }
});

module.exports = router;
