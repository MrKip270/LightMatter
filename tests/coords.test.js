// Tests for the pure coordinate helpers shared by the frontend.
//
// These cover frontend/coords.js, which is deliberately free of DOM access so
// Node can require() it. app.js itself cannot be tested this way — it calls
// document.getElementById at load time.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  wrapLongitude,
  clampLatitude,
  normalizeCoords,
  parseCoordinates,
} = require("../frontend/coords");

test("REGRESSION: longitudes past the dateline wrap instead of accumulating", () => {
  // The bug: Leaflet renders repeated copies of the world, and a click reports
  // the longitude of the copy you clicked. Panning east kept adding 360 —
  // 190, 550, 910 — and every one of those was rejected by the API's
  // -180..180 validation, so clicks silently stopped working the further you
  // panned.
  assert.equal(wrapLongitude(190), -170, "one world east");
  assert.equal(wrapLongitude(550), -170, "two worlds east");
  assert.equal(wrapLongitude(910), -170, "three worlds east");

  assert.equal(wrapLongitude(-190), 170, "one world west");
  assert.equal(wrapLongitude(-550), 170, "two worlds west");
  assert.equal(wrapLongitude(-910), 170, "three worlds west");
});

test("wrapping is idempotent and always lands in range", () => {
  // A property check: wrapping any longitude, however extreme, must produce a
  // value the API accepts — and wrapping again must change nothing.
  for (let lon = -2000; lon <= 2000; lon += 7.3) {
    const wrapped = wrapLongitude(lon);
    assert.ok(
      wrapped >= -180 && wrapped <= 180,
      `${lon} wrapped to ${wrapped}, outside the valid range`
    );
    assert.equal(wrapLongitude(wrapped), wrapped, `wrapping ${wrapped} again changed it`);
  }
});

test("wrapping preserves values that are already valid", () => {
  // Including the exact endpoints. An earlier formula flipped 180 to -180,
  // which is the same meridian but surprising to see in a round trip.
  for (const lon of [-180, -179.9, -87.63, 0, 18.9553, 179.9, 180]) {
    assert.equal(wrapLongitude(lon), lon, `${lon} should pass through unchanged`);
  }
});

test("wrapping lands on the same physical meridian", () => {
  // The wrap is only correct if the result describes the same place. Anything
  // differing by a whole number of full turns must collapse to one value.
  const base = -77.8164; // Cherry Springs
  for (const turns of [1, 2, 5, -1, -3]) {
    assert.ok(
      Math.abs(wrapLongitude(base + 360 * turns) - base) < 1e-9,
      `${turns} turns from ${base} should return to it`
    );
  }
});

test("latitude clamps rather than wraps", () => {
  // The poles are ends, not seams. Wrapping latitude would teleport a click
  // past the north pole into the southern hemisphere.
  assert.equal(clampLatitude(95), 90);
  assert.equal(clampLatitude(-95), -90);
  assert.equal(clampLatitude(41.88), 41.88);
  assert.equal(clampLatitude(90), 90);
  assert.equal(clampLatitude(-90), -90);
});

test("normalizeCoords produces values the API will accept", () => {
  const { lat, lon } = normalizeCoords(95, 550);
  assert.equal(lat, 90);
  assert.equal(lon, -170);

  // Whatever goes in, what comes out must satisfy the API's contract.
  for (const testLat of [-200, -90, 0, 41.88, 90, 200]) {
    for (const testLon of [-900, -180, 0, 180, 900]) {
      const result = normalizeCoords(testLat, testLon);
      assert.ok(result.lat >= -90 && result.lat <= 90, `lat ${testLat} -> ${result.lat}`);
      assert.ok(result.lon >= -180 && result.lon <= 180, `lon ${testLon} -> ${result.lon}`);
    }
  }
});

test("parseCoordinates reads a typed coordinate pair", () => {
  assert.deepEqual(parseCoordinates("(41.88, -87.63)"), { lat: 41.88, lon: -87.63 });
  assert.deepEqual(parseCoordinates("(41.88,-87.63)"), { lat: 41.88, lon: -87.63 });
  assert.deepEqual(parseCoordinates("  ( 41.88 , -87.63 )  "), { lat: 41.88, lon: -87.63 });
  assert.deepEqual(parseCoordinates("(0, 0)"), { lat: 0, lon: 0 });
  assert.deepEqual(parseCoordinates("(-33, 151)"), { lat: -33, lon: 151 });
});

test("parseCoordinates returns null for anything that isn't a pair", () => {
  // Returning null is what makes the caller fall through to treating the text
  // as a place name, so these all end up going to the geocoder instead.
  assert.equal(parseCoordinates("Chicago"), null);
  assert.equal(parseCoordinates("41.88, -87.63"), null, "needs the parentheses");
  assert.equal(parseCoordinates("(41.88)"), null, "needs both numbers");
  assert.equal(parseCoordinates(""), null);
  assert.equal(parseCoordinates("()"), null);
});

test("typed coordinates are REJECTED out of range, not wrapped", () => {
  // Deliberately different from a map click. "(41, 200)" is far more likely a
  // typo than an intentional reference to 160°W, so it falls through to a place
  // name lookup rather than silently relocating the user 20 degrees away.
  assert.equal(parseCoordinates("(41, 200)"), null);
  assert.equal(parseCoordinates("(91, 0)"), null);
  assert.equal(parseCoordinates("(-91, 0)"), null);
  assert.equal(parseCoordinates("(0, -181)"), null);

  // The exact boundaries are still valid.
  assert.deepEqual(parseCoordinates("(90, 180)"), { lat: 90, lon: 180 });
  assert.deepEqual(parseCoordinates("(-90, -180)"), { lat: -90, lon: -180 });
});
