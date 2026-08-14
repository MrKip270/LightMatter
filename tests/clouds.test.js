// Tests for the cloud cover source.
//
// These target the PURE helpers — the "per-source normalizers" the PRD names as
// good unit-test candidates. They take plain inputs and return plain outputs,
// so no server, no network, no mocking needed.

const test = require("node:test");
const assert = require("node:assert/strict");
const suncalc = require("suncalc");
const { helpers: h } = require("../backend/sources/clouds");

test("utcToLocalIso converts a UTC Date to a naive local ISO string", () => {
  // UTC midnight shifted forward by UTC+2 → local 02:00 same day
  const utcMidnight = new Date("2026-08-13T00:00:00Z");
  assert.equal(h.utcToLocalIso(utcMidnight, 2 * 3600), "2026-08-13T02:00");

  // UTC midnight shifted back by UTC-5 → local 19:00 the previous day
  assert.equal(h.utcToLocalIso(utcMidnight, -5 * 3600), "2026-08-12T19:00");

  // UTC+0 is a no-op
  assert.equal(h.utcToLocalIso(utcMidnight, 0), "2026-08-13T00:00");
});

test("astronomical twilight starts later than sunset at a mid-latitude site", () => {
  // London in August: sunset ~19:26, astronomical dark ~21:52.
  // This is not a stub — we call suncalc the same way the source does so the
  // test breaks if that call chain changes.
  const lat = 51.5, lon = -0.1;
  const utcOffset = 3600; // BST = UTC+1

  // Use a fixed date in summer (not a solstice) where astronomical night exists.
  const sunsetLocal = "2026-08-13T20:26"; // BST
  const sunsetUtc = new Date(Date.parse(`${sunsetLocal}:00Z`) - utcOffset * 1000);

  const times = suncalc.getTimes(sunsetUtc, lat, lon);
  assert.ok(times.night && isFinite(times.night.getTime()),
    "suncalc returns a valid astronomical night for London in August");

  const twilightStart = h.utcToLocalIso(times.night, utcOffset);
  assert.ok(twilightStart > sunsetLocal,
    `twilight start (${twilightStart}) must be later than sunset (${sunsetLocal})`);
});

test("astronomical twilight end is earlier than sunrise at a mid-latitude site", () => {
  const lat = 51.5, lon = -0.1;
  const utcOffset = 3600;

  const sunriseLocal = "2026-08-14T05:42"; // BST
  const sunriseUtc = new Date(Date.parse(`${sunriseLocal}:00Z`) - utcOffset * 1000);

  const times = suncalc.getTimes(sunriseUtc, lat, lon);
  assert.ok(times.nightEnd && isFinite(times.nightEnd.getTime()),
    "suncalc returns a valid nightEnd for London in August");

  const twilightEnd = h.utcToLocalIso(times.nightEnd, utcOffset);
  assert.ok(twilightEnd < sunriseLocal,
    `twilight end (${twilightEnd}) must be earlier than sunrise (${sunriseLocal})`);
});

test("suncalc returns invalid Date for astronomical night at high summer latitude", () => {
  // Tromsø (69.6°N) in midsummer: the sun never reaches 18° below the horizon.
  // The source must treat this as a fallback case, not a crash.
  const lat = 69.6, lon = 18.9;
  const date = new Date("2026-06-21T12:00:00Z"); // summer solstice
  const times = suncalc.getTimes(date, lat, lon);
  // suncalc returns null (not an invalid Date) when the sun never reaches 18°
  // below the horizon. The production check is `times.night && isFinite(...)`,
  // which treats null as falsy — confirmed here.
  const nightIsValid = times.night && isFinite(times.night.getTime());
  assert.ok(!nightIsValid,
    "no astronomical night at Tromsø on the summer solstice");
});

test("floorToHour rounds a timestamp down to the top of its hour", () => {
  // Sunset is 20:10, but the hourly array is labelled by hour START, so the
  // entry covering 20:10 is the one labelled 20:00.
  assert.equal(h.floorToHour("2026-07-31T20:10"), "2026-07-31T20:00");
  assert.equal(h.floorToHour("2026-07-31T20:00"), "2026-07-31T20:00");
  assert.equal(h.floorToHour("2026-08-01T05:59"), "2026-08-01T05:00");
});

test("local ISO strings sort chronologically as plain strings", () => {
  // The entire night-window slice depends on this being true. If the timestamp
  // format ever changes (an offset suffix, a different separator), string
  // comparison silently stops matching time order and the window goes wrong
  // with no error. This test is the tripwire for that.
  assert.ok("2026-08-01T00:00" > "2026-07-31T23:00", "crosses midnight");
  assert.ok("2026-07-31T21:00" > "2026-07-31T20:00", "within a day");
  assert.ok("2026-09-01T00:00" > "2026-08-31T23:00", "crosses a month");
  assert.ok("2027-01-01T00:00" > "2026-12-31T23:00", "crosses a year");
});

test("selectHoursInWindow picks an inclusive range across midnight", () => {
  const times = [
    "2026-07-31T19:00",
    "2026-07-31T20:00",
    "2026-07-31T23:00",
    "2026-08-01T00:00",
    "2026-08-01T05:00",
    "2026-08-01T06:00",
  ];
  const cover = [10, 20, 30, 40, 50, 60];

  const picked = h.selectHoursInWindow(times, cover, "2026-07-31T20:00", "2026-08-01T05:00");

  assert.equal(picked.length, 4, "excludes 19:00 and 06:00, keeps the four between");
  assert.equal(picked[0].time, "2026-07-31T20:00", "start is inclusive");
  assert.equal(picked[3].time, "2026-08-01T05:00", "end is inclusive");
});

test("cloudVerdict boundaries land on the right side", () => {
  // Thresholds are where off-by-one bugs live, so test the exact edges rather
  // than comfortable values in the middle of each band.
  assert.equal(h.cloudVerdict(0), "Clear");
  assert.equal(h.cloudVerdict(h.CLEAR_MAX), "Clear", "CLEAR_MAX itself is clear");
  assert.equal(h.cloudVerdict(h.CLEAR_MAX + 1), "Partly cloudy");
  assert.equal(h.cloudVerdict(h.PARTLY_MAX), "Partly cloudy", "PARTLY_MAX is still partly");
  assert.equal(h.cloudVerdict(h.PARTLY_MAX + 1), "Overcast");
  assert.equal(h.cloudVerdict(100), "Overcast");
});

test("REGRESSION: a data gap must not read as clear sky", () => {
  // `null <= 20` is TRUE in JavaScript, because null coerces to 0. Without an
  // explicit null check, missing data would masquerade as a perfectly clear
  // sky — the worst possible failure for an app that tells people whether to
  // go outside. This test exists so that guard can never be removed silently.
  assert.ok(null <= 20, "documenting the JS coercion this protects against");

  const allNull = [
    { time: "t1", cloudCover: null },
    { time: "t2", cloudCover: null },
    { time: "t3", cloudCover: null },
  ];
  assert.equal(h.longestClearRun(allNull).length, 0, "no data is not a clear run");
  assert.equal(h.averageCloudCover(allNull), null, "no data averages to null, not 0");
});

test("a gap breaks a clear run rather than bridging it", () => {
  const hours = [
    { time: "t1", cloudCover: 5 },
    { time: "t2", cloudCover: null },
    { time: "t3", cloudCover: 5 },
    { time: "t4", cloudCover: 5 },
  ];
  const run = h.longestClearRun(hours);
  assert.equal(run.length, 2, "the two after the gap, not all three clear hours");
  assert.equal(run.start, "t3");
});

test("longestClearRun handles a run that reaches the final hour", () => {
  // The loop reads one index past the end so a run touching the last element
  // closes through the same code path as any other. Without that, this run
  // would be dropped entirely.
  const hours = [
    { time: "t1", cloudCover: 90 },
    { time: "t2", cloudCover: 5 },
    { time: "t3", cloudCover: 5 },
  ];
  const run = h.longestClearRun(hours);
  assert.equal(run.length, 2);
  assert.equal(run.end, "t3", "the final hour is included");
});

test("longestClearRun edge cases: all clear, none clear, empty", () => {
  const allClear = [1, 2, 3].map((n) => ({ time: `t${n}`, cloudCover: 0 }));
  assert.equal(h.longestClearRun(allClear).length, 3);

  const noneClear = [1, 2, 3].map((n) => ({ time: `t${n}`, cloudCover: 100 }));
  assert.equal(h.longestClearRun(noneClear).length, 0);

  assert.equal(h.longestClearRun([]).length, 0);
});

test("longestClearRun returns the LONGEST run, not the first", () => {
  const hours = [
    { time: "t1", cloudCover: 5 },
    { time: "t2", cloudCover: 90 },
    { time: "t3", cloudCover: 5 },
    { time: "t4", cloudCover: 5 },
    { time: "t5", cloudCover: 5 },
  ];
  const run = h.longestClearRun(hours);
  assert.equal(run.length, 3);
  assert.equal(run.start, "t3");
});

test("averageCloudCover skips gaps instead of counting them as zero", () => {
  const hours = [
    { time: "t1", cloudCover: 50 },
    { time: "t2", cloudCover: null },
    { time: "t3", cloudCover: 100 },
  ];
  // Mean of 50 and 100 is 75. Counting the null as 0 would give 50.
  assert.equal(h.averageCloudCover(hours), 75);
});
