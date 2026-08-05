// LightMatter — aurora data source
//
// Pure data logic: no Express, no req/res, no status codes. Give it
// coordinates, get back a normalized object or an Error. That separation is
// what lets BOTH /api/aurora and /api/sky use this without one calling the
// other over HTTP.

const NOAA_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";

async function getAurora(lat, lon) {
  const response = await fetch(NOAA_URL);
  if (!response.ok) {
    throw new Error(`NOAA responded with status ${response.status}`);
  }
  const data = await response.json();

  // NOAA stores longitude as 0..359; we use -180..180. Both get rounded to
  // NOAA's 1-degree grid.
  const gridLat = Math.round(lat);
  const gridLon = Math.round((lon + 360) % 360);

  const cell = data.coordinates.find(
    (point) => point[0] === gridLon && point[1] === gridLat
  );

  return {
    source: "NOAA SWPC OVATION",
    dataAvailable: true,
    observationTime: data["Observation Time"],
    forecastTime: data["Forecast Time"],
    location: { lat, lon },
    auroraProbability: cell ? cell[2] : 0, // percent, 0-100
  };
}

module.exports = { getAurora };
