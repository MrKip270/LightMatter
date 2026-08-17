// LightMatter — nearest dark site route
//
// Thin HTTP wrapper; the search itself lives in ../sources/darksite.js.

const express = require("express");
const {
  findNearestDarkSite,
  findNearestGoodWeatherDarkSite,
  DEFAULT_MIN_SQM,
} = require("../sources/darksite");
const { validateCoordinates } = require("./validate");

const router = express.Router();

function parseMinSqm(req, res) {
  const minSqm = req.query.minSqm !== undefined ? Number(req.query.minSqm) : DEFAULT_MIN_SQM;
  if (Number.isNaN(minSqm)) {
    res.status(400).json({ error: "minSqm must be a number" });
    return null;
  }
  return minSqm;
}

router.get("/", (req, res) => {
  const coords = validateCoordinates(req.query);
  if (coords.error) return res.status(400).json({ error: coords.error });

  const minSqm = parseMinSqm(req, res);
  if (minSqm === null) return;

  try {
    res.json(findNearestDarkSite(coords.lat, coords.lon, minSqm));
  } catch (err) {
    // 503 when the grid failed to load — that is our problem, not the
    // caller's, and it is fixed by running the build tool.
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Same search, widened to the nearest few dark-enough sites and checked
// against tonight's forecast — a real destination, not just a dark one.
router.get("/tonight", async (req, res) => {
  const coords = validateCoordinates(req.query);
  if (coords.error) return res.status(400).json({ error: coords.error });

  const minSqm = parseMinSqm(req, res);
  if (minSqm === null) return;

  try {
    res.json(await findNearestGoodWeatherDarkSite(coords.lat, coords.lon, minSqm));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
