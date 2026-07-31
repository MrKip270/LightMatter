// LightMatter — geocoding route
// Turns a place name (e.g. "Washington DC") into coordinates.
// Data source: Open-Meteo Geocoding API (no key required).
//
// This is the shared first step for the whole app: every data source
// (aurora, clouds, etc.) is queried by lat/lon, so we translate the user's
// typed location into coordinates once, here, and reuse the result everywhere.

const express = require("express");
const router = express.Router();

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

// GET /api/geocode?q=Washington
router.get("/", async (req, res) => {
  // Read the search text; trim() removes stray leading/trailing spaces.
  const query = (req.query.q ?? "").trim();

  // No search text -> nothing to look up.
  if (!query) {
    return res.status(400).json({ error: "Provide a place name with ?q=" });
  }

  try {
    // encodeURIComponent makes the text safe to place inside a URL:
    // spaces, commas, and accents become %20, %2C, etc. Without it,
    // "Washington DC" would break the URL at the space.
    const url =
      `${GEOCODE_URL}?name=${encodeURIComponent(query)}` +
      `&count=5&language=en&format=json`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Geocoder responded with status ${response.status}`);
    }
    const data = await response.json();

    // Open-Meteo leaves out "results" entirely when nothing matches,
    // so we default to an empty array. Then we reshape each match into
    // OUR clean, minimal format — the frontend never sees Open-Meteo's
    // 200-field objects, just what we choose to expose.
    const results = (data.results ?? []).map((place) => ({
      name: place.name,
      region: place.admin1, // state / province (may be undefined)
      country: place.country,
      lat: place.latitude,
      lon: place.longitude,
    }));

    res.json({ query, results });
  } catch (err) {
    res
      .status(502)
      .json({ error: "Could not geocode location", detail: err.message });
  }
});

module.exports = router;
