// LightMatter — shared request validation
//
// The same lat/lon check was copy-pasted into three routes. Three copies means
// three places to fix a bug and three chances for them to drift apart, so it
// lives here now. Small, but this is the kind of duplication that quietly
// becomes inconsistency as a codebase grows.

// Defaults match across every route so a bare call describes the same place.
// Tromsø, Norway — deep in the auroral zone, so the demo usually shows
// something interesting.
const DEFAULT_LAT = 70;
const DEFAULT_LON = 19;

function validateCoordinates(query) {
  const lat = Number(query.lat ?? DEFAULT_LAT);
  const lon = Number(query.lon ?? DEFAULT_LON);

  if (
    Number.isNaN(lat) ||
    Number.isNaN(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return { error: "lat must be -90..90 and lon must be -180..180" };
  }

  return { lat, lon };
}

module.exports = { validateCoordinates, DEFAULT_LAT, DEFAULT_LON };
