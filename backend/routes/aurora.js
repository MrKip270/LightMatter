// LightMatter — aurora route
// Data source: NOAA SWPC OVATION model (no API key required).
// It gives an aurora probability (0-100%) for every 1-degree grid cell
// on Earth. We fetch it and look up the cell nearest the user's location.

const express = require("express");

// A Router is a mini Express app just for this feature's routes. We build
// it here and "mount" it in server.js. This keeps each data source's code
// in its own file, exactly as the PRD planned.
const router = express.Router();

const NOAA_URL =
  "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";

// Handle GET requests to this router's root.
// Because we'll mount it at "/api/aurora", the full URL is:
//   /api/aurora?lat=65&lon=-148
//
// "async" lets us use "await" below to pause for the network call without
// freezing the whole server.
router.get("/", async (req, res) => {
  // 1. Read lat/lon from the query string (the "?lat=..&lon=.." part).
  //    "??" means "if that value is missing, use this default instead."
  //    Default: Tromsø, Norway — deep in the auroral zone, so the demo
  //    usually shows a non-zero chance.
  const lat = Number(req.query.lat ?? 70);
  const lon = Number(req.query.lon ?? 19);

  // 2. Validate. If either isn't a real number or is out of range, reply
  //    with 400 ("Bad Request") and stop.
  if (
    Number.isNaN(lat) ||
    Number.isNaN(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return res
      .status(400)
      .json({ error: "lat must be -90..90 and lon must be -180..180" });
  }

  try {
    // 3. Fetch the live data. "await" waits for NOAA to respond.
    //    fetch() is built into modern Node, so no extra library needed.
    const response = await fetch(NOAA_URL);
    if (!response.ok) {
      throw new Error(`NOAA responded with status ${response.status}`);
    }
    const data = await response.json();

    // 4. NOAA stores longitude as 0..359, but we use -180..180.
    //    Convert, and round both values to match the 1-degree grid.
    const gridLat = Math.round(lat);
    const gridLon = Math.round((lon + 360) % 360);

    // 5. Find the grid cell matching our rounded coordinates.
    //    Each entry looks like [longitude, latitude, probability].
    const cell = data.coordinates.find(
      (point) => point[0] === gridLon && point[1] === gridLat
    );
    const probability = cell ? cell[2] : 0;

    // 6. Send back a small, clean JSON result — not the whole giant grid.
    res.json({
      source: "NOAA SWPC OVATION",
      observationTime: data["Observation Time"],
      forecastTime: data["Forecast Time"],
      location: { lat, lon },
      auroraProbability: probability, // percent chance, 0-100
    });
  } catch (err) {
    // 7. Resilience (from the PRD): if NOAA is down or anything fails,
    //    respond with a clear error instead of crashing the server.
    res
      .status(502)
      .json({ error: "Could not fetch aurora data", detail: err.message });
  }
});

// Expose the router so server.js can mount it.
module.exports = router;
