// LightMatter — pure coordinate helpers
//
// Deliberately free of any DOM access, so this file works in two places:
//   - the browser, loaded by a <script> tag before app.js
//   - Node, via require(), so the test suite can cover it
//
// app.js cannot be tested this way because it touches document.getElementById
// at load time, which throws outside a browser. Splitting the pure maths out is
// what makes it testable at all.

// Bring a longitude back into -180..180.
//
// WHY THIS IS NEEDED: Leaflet renders repeated copies of the world side by
// side, and a click reports the longitude of the copy you clicked — pan two
// worlds east and you get 190, 480, 730. Those are all the same meridian, but
// our API validates -180..180 and rejects them, so the click silently fails.
//
// The double modulo handles negatives: JavaScript's % keeps the sign of the
// left operand, so (-190 + 180) % 360 is -10, not 350. Adding 360 and taking
// the modulo again forces a positive result before shifting back.
function wrapLongitude(lon) {
  // Leave already-valid values exactly alone, so 180 stays 180 rather than
  // flipping to -180. Same meridian either way, but round-tripping a value
  // unchanged is less surprising.
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// Latitude does not wrap — the poles are ends, not seams. Web Mercator already
// limits a map click to about ±85, so this is belt-and-braces against a
// different projection or a bad caller.
function clampLatitude(lat) {
  return Math.max(-90, Math.min(90, lat));
}

// Normalize a coordinate pair from any source into something the API accepts.
function normalizeCoords(lat, lon) {
  return { lat: clampLatitude(lat), lon: wrapLongitude(lon) };
}

// Try to read "(lat, lon)" out of typed text.
// Returns { lat, lon } or null if the text isn't coordinates and should be
// treated as a place name instead.
function parseCoordinates(text) {
  // Regex breakdown:
  //   \(              a literal "("
  //   \s*             optional spaces
  //   (-?\d+(?:\.\d+)?)  a number: optional "-", digits, optional ".decimals"
  //   \s*,\s*         a comma with optional spaces around it
  //   (-?\d+(?:\.\d+)?)  the second number
  //   \)              a literal ")"
  const match = String(text).match(
    /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/
  );
  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);

  // Reject impossible coordinates rather than wrapping them. Typed input is
  // different from a map click: "(41, 200)" is far more likely to be a typo
  // than an intentional reference to 160°W, so we fall through to treating the
  // text as a place name instead of silently relocating the user.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon };
}

// Dual export: a no-op in the browser, the module interface in Node.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { wrapLongitude, clampLatitude, normalizeCoords, parseCoordinates };
}
