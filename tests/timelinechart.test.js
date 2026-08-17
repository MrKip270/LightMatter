// Tests for the pure hourly-chart geometry.
//
// Covers frontend/timelinechart.js, which has no DOM access so Node can
// require() it — same reason coords.js and format.js are tested this way.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTimelineChart,
  buildTableRows,
  interpolateColour,
  nearestIndex,
  xForIndex,
  VIEW_WIDTH,
} = require("../frontend/timelinechart");

const STOPS = [
  { sqm: 16.0, colour: "rgb(255, 255, 255)" },
  { sqm: 19.0, colour: "rgb(255, 235, 90)" },
  { sqm: 22.0, colour: "rgb(8, 10, 30)" },
];

function hour(overrides) {
  return {
    time: "2026-08-05T21:00",
    cloudCover: 10,
    clear: true,
    moonAltitude: -5,
    effectiveSqm: 21,
    moonPenalty: 0,
    ...overrides,
  };
}

test("interpolateColour matches an exact stop", () => {
  assert.equal(interpolateColour(16, STOPS), "rgb(255, 255, 255)");
  assert.equal(interpolateColour(22, STOPS), "rgb(8, 10, 30)");
});

test("interpolateColour blends linearly between stops", () => {
  // Halfway between 16.0 (255,255,255) and 19.0 (255,235,90) is 17.5.
  assert.equal(interpolateColour(17.5, STOPS), "rgb(255, 245, 173)");
});

test("interpolateColour clamps outside the stop range rather than extrapolating", () => {
  assert.equal(interpolateColour(10, STOPS), "rgb(255, 255, 255)");
  assert.equal(interpolateColour(25, STOPS), "rgb(8, 10, 30)");
});

test("interpolateColour degrades on missing input", () => {
  assert.equal(interpolateColour(null, STOPS), null);
  assert.equal(interpolateColour(19, null), null);
  assert.equal(interpolateColour(19, []), null);
});

test("buildTimelineChart refuses fewer than two points", () => {
  // A single-hour night can't draw a line — nothing to connect.
  assert.equal(buildTimelineChart(null, null, STOPS), null);
  assert.equal(buildTimelineChart([], null, STOPS), null);
  assert.equal(buildTimelineChart([hour()], null, STOPS), null);
});

test("buildTimelineChart spaces points evenly across the width, first and last touch the pad", () => {
  const timeline = [hour({ time: "20:00" }), hour({ time: "21:00" }), hour({ time: "22:00" })];
  const chart = buildTimelineChart(timeline, null, STOPS);
  assert.equal(chart.cloud.points.length, 3);
  assert.equal(chart.cloud.points[0].x, xForIndex(0, 3));
  assert.equal(chart.cloud.points[2].x, xForIndex(2, 3));
  assert.ok(chart.cloud.points[0].x < chart.cloud.points[1].x);
  assert.ok(chart.cloud.points[1].x < chart.cloud.points[2].x);
});

test("higher cloud cover sits higher up the panel (smaller y, since SVG y grows downward)", () => {
  const timeline = [hour({ cloudCover: 0 }), hour({ cloudCover: 100 })];
  const chart = buildTimelineChart(timeline, null, STOPS);
  assert.equal(chart.cloud.points[0].y, chart.cloud.height, "0% sits at the baseline");
  assert.equal(chart.cloud.points[1].y, 0, "100% sits at the panel top");
});

test("higher effective SQM (darker sky) sits higher up its panel", () => {
  const timeline = [hour({ effectiveSqm: 16 }), hour({ effectiveSqm: 22 })];
  const chart = buildTimelineChart(timeline, null, STOPS);
  const bright = chart.sqm.points[0];
  const dark = chart.sqm.points[1];
  assert.ok(dark.y < bright.y, "22 mag/arcsec² should draw above 16");
});

test("a null hour breaks the line into segments instead of interpolating across the gap", () => {
  const timeline = [
    hour({ cloudCover: 10 }),
    hour({ cloudCover: null }),
    hour({ cloudCover: 90 }),
  ];
  const chart = buildTimelineChart(timeline, null, STOPS);
  assert.equal(chart.cloud.linePaths.length, 2, "one segment before the gap, one after");
});

test("bestWindowRect spans from the start hour to the end hour", () => {
  const timeline = [
    hour({ time: "20:00" }),
    hour({ time: "21:00" }),
    hour({ time: "22:00" }),
    hour({ time: "23:00" }),
  ];
  const chart = buildTimelineChart(timeline, { start: "21:00", end: "22:00" }, STOPS);
  assert.ok(chart.bestWindowRect);
  assert.ok(chart.bestWindowRect.x > 0);
  assert.ok(chart.bestWindowRect.width > 0);
});

test("bestWindowRect is omitted when the window's hours are not in the timeline", () => {
  const timeline = [hour({ time: "20:00" }), hour({ time: "21:00" })];
  const chart = buildTimelineChart(timeline, { start: "05:00", end: "06:00" }, STOPS);
  assert.equal(chart.bestWindowRect, null);
});

test("moon ticks fire only on a sign crossing, not every positive hour", () => {
  const timeline = [
    hour({ moonAltitude: -10 }),
    hour({ moonAltitude: -1 }),
    hour({ moonAltitude: 5 }), // rise between index 1 and 2
    hour({ moonAltitude: 10 }),
    hour({ moonAltitude: -2 }), // set between index 3 and 4
  ];
  const chart = buildTimelineChart(timeline, null, STOPS);
  assert.equal(chart.moonTicks.length, 2);
  assert.equal(chart.moonTicks[0].kind, "rise");
  assert.equal(chart.moonTicks[1].kind, "set");
});

test("moon ticks skip crossings adjacent to missing data", () => {
  const timeline = [hour({ moonAltitude: -5 }), hour({ moonAltitude: null }), hour({ moonAltitude: 5 })];
  const chart = buildTimelineChart(timeline, null, STOPS);
  assert.equal(chart.moonTicks.length, 0);
});

// Property test: sweep a range of night lengths and confirm x stays in-bounds
// and monotonic, and the chart never throws — catches off-by-ones that only
// show up at specific lengths (a lone earlier bug class in this project).
test("x positions stay within the viewBox width for any night length", () => {
  for (let n = 2; n <= 24; n++) {
    const timeline = Array.from({ length: n }, (_, i) => hour({ time: `t${i}`, cloudCover: (i * 7) % 100 }));
    const chart = buildTimelineChart(timeline, null, STOPS);
    for (const p of chart.cloud.points) {
      assert.ok(p.x >= 0 && p.x <= VIEW_WIDTH, `n=${n} produced an out-of-bounds x`);
    }
    for (let i = 1; i < chart.cloud.points.length; i++) {
      assert.ok(
        chart.cloud.points[i].x > chart.cloud.points[i - 1].x,
        `n=${n} produced non-monotonic x`
      );
    }
  }
});

test("nearestIndex clamps to the array bounds", () => {
  assert.equal(nearestIndex(-50, 5), 0);
  assert.equal(nearestIndex(VIEW_WIDTH + 50, 5), 4);
});

test("buildTableRows mirrors the timeline so every charted value is reachable without hovering", () => {
  const timeline = [hour({ time: "20:00" }), hour({ time: "21:00" })];
  const rows = buildTableRows(timeline);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].time, "20:00");
  assert.equal(rows[0].effectiveSqm, 21);
});

test("buildTableRows degrades on a missing timeline", () => {
  assert.deepEqual(buildTableRows(null), []);
  assert.deepEqual(buildTableRows(undefined), []);
});
