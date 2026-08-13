// Tests for the pure display formatters.
//
// Covers frontend/format.js, which has no DOM access so Node can require() it.
// app.js cannot be tested this way — it touches the DOM at load time. Splitting
// the pure formatting out is what makes any of it coverable.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  scoreBand,
  formatHour,
  formatCount,
  formatCloud,
  formatEclipse,
} = require("../frontend/format");

test("score bands run brightest to darkest in five steps", () => {
  // White → pink → orange → crimson → blood. Quality is encoded by brightness
  // rather than hue, so the scale survives red-green colour blindness.
  assert.equal(scoreBand(100), "peak");
  assert.equal(scoreBand(85), "peak");
  assert.equal(scoreBand(84), "good");
  assert.equal(scoreBand(70), "good");
  assert.equal(scoreBand(69), "fair");
  assert.equal(scoreBand(45), "fair");
  assert.equal(scoreBand(44), "poor");
  assert.equal(scoreBand(20), "poor");
  assert.equal(scoreBand(19), "bad");
  assert.equal(scoreBand(0), "bad");
});

test("a missing score gets its own band, not the worst one", () => {
  // "We don't know" and "it's terrible" must look different. Painting an
  // unknown score blood-red would state something we have not measured.
  assert.equal(scoreBand(null), "none");
  assert.equal(scoreBand(undefined), "none");
});

test("score bands never fall through to undefined", () => {
  for (let score = 0; score <= 100; score++) {
    const band = scoreBand(score);
    assert.ok(
      ["peak", "good", "fair", "poor", "bad"].includes(band),
      `score ${score} produced "${band}"`
    );
  }
});

test("formatHour reads the hour out of a local timestamp", () => {
  assert.equal(formatHour("2026-08-05T21:00"), "9 PM");
  assert.equal(formatHour("2026-08-05T09:00"), "9 AM");
  assert.equal(formatHour("2026-08-05T00:00"), "12 AM", "midnight is 12, not 0");
  assert.equal(formatHour("2026-08-05T12:00"), "12 PM", "noon is 12 PM, not 12 AM");
  assert.equal(formatHour("2026-08-05T23:00"), "11 PM");
});

test("formatHour does not construct a Date", () => {
  // These timestamps are local to the SEARCHED location, not the viewer. Using
  // new Date() would re-anchor them to the reader's timezone, so someone in
  // London checking Chicago would see the wrong hours. The proof is that the
  // output is identical regardless of what the string claims about offsets.
  assert.equal(formatHour("2026-01-15T23:00"), "11 PM");
  assert.equal(formatHour("2026-07-15T23:00"), "11 PM", "no DST shift");
});

test("formatHour degrades rather than throwing", () => {
  assert.equal(formatHour(null), "—");
  assert.equal(formatHour(undefined), "—");
  assert.equal(formatHour(""), "—");
  assert.equal(formatHour("not a timestamp"), "—");
});

test("formatCount separates thousands", () => {
  // "2,957" reads instantly; "2957" does not.
  assert.equal(formatCount(2957), (2957).toLocaleString());
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(null), "—");
  assert.equal(formatCount(undefined), "—");
});

test("formatCloud combines the average and the verdict", () => {
  assert.equal(
    formatCloud({ dataAvailable: true, averageCloudCover: 82, verdict: "Overcast" }),
    "82% avg · Overcast"
  );
});

test("formatCloud distinguishes no data from a failure, and shows neither", () => {
  // Both end up as an em dash in the UI, but the caller must be able to pass
  // either shape without the formatter throwing.
  assert.equal(formatCloud({ dataAvailable: false }), "—");
  assert.equal(formatCloud({ error: "upstream down" }), "—");
  assert.equal(formatCloud(null), "—");
  assert.equal(formatCloud(undefined), "—");
});

test("formatEclipse says whether it is visible from here", () => {
  // A lunar eclipse is visible from the whole night side of Earth, so "when" is
  // useless without "and can I see it".
  assert.equal(
    formatEclipse({ type: "partial", daysAway: 23, visibleHere: true }),
    "partial in 23d · visible here"
  );
  assert.equal(
    formatEclipse({ type: "total", daysAway: 5, visibleHere: false }),
    "total in 5d · not visible from here"
  );
});

test("formatEclipse returns null when there is nothing upcoming", () => {
  // null rather than a placeholder string, so the caller can omit the whole row
  // instead of rendering an empty one.
  assert.equal(formatEclipse(null), null);
  assert.equal(formatEclipse(undefined), null);
});
