// LightMatter — pure geometry for the hourly timeline chart
//
// Same pattern as coords.js/format.js: no DOM access, so Node can require()
// this and the test suite can cover it. Turns the /api/sky `timeline` array
// into SVG path strings and coordinates; app.js just interpolates them into
// markup and wires up hover.
//
// Two stacked single-axis panels (cloud cover, effective sky darkness) rather
// than one dual-axis chart — cloudCover (%) and effectiveSqm (mag/arcsec²)
// are different units, and a shared y-axis would misrepresent both. Moon
// altitude isn't a third panel: its effect is already folded into
// effectiveSqm (see scoring.js), so it only needs rise/set tick marks for
// context, not its own trace.

const VIEW_WIDTH = 600;
const PAD_X = 4;
const CLOUD_HEIGHT = 56;
const SQM_HEIGHT = 56;
const PANEL_GAP = 16;
const AXIS_HEIGHT = 26;
const VIEW_HEIGHT = CLOUD_HEIGHT + PANEL_GAP + SQM_HEIGHT + AXIS_HEIGHT;

// Matches the light-pollution legend's palette domain (lightpollutiontiles.js
// PALETTE spans 16.0-22.0) so a given SQM reads as the same colour everywhere
// it appears in the app, on the map or in this chart.
const SQM_DOMAIN = [16, 22];

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function xForIndex(i, n) {
  if (n <= 1) return PAD_X;
  return PAD_X + (i / (n - 1)) * (VIEW_WIDTH - PAD_X * 2);
}

function nearestIndex(x, n) {
  if (n <= 1) return 0;
  const step = (VIEW_WIDTH - PAD_X * 2) / (n - 1);
  return clamp(Math.round((x - PAD_X) / step), 0, n - 1);
}

function parseRgb(str) {
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(str || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

// Linear RGB interpolation between the legend's stops. Given the exact same
// stops object legendMarkup() already fetches from /api/lightpollution/tile/legend,
// so this can never drift from what the map draws for the same SQM value.
function interpolateColour(sqm, stops) {
  if (sqm === null || sqm === undefined || !stops || !stops.length) return null;
  if (sqm <= stops[0].sqm) return stops[0].colour;
  const last = stops[stops.length - 1];
  if (sqm >= last.sqm) return last.colour;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (sqm >= a.sqm && sqm <= b.sqm) {
      const t = (sqm - a.sqm) / (b.sqm - a.sqm);
      const [ar, ag, ab] = parseRgb(a.colour);
      const [br, bg, bb] = parseRgb(b.colour);
      const r = Math.round(ar + (br - ar) * t);
      const g = Math.round(ag + (bg - ag) * t);
      const bl = Math.round(ab + (bb - ab) * t);
      return `rgb(${r}, ${g}, ${bl})`;
    }
  }
  return last.colour;
}

// Splits a point array into runs at nulls, so a gap in the data (a missing
// forecast hour) breaks the line instead of drawing a straight lie across it.
function toSegments(points) {
  const segments = [];
  let current = [];
  for (const p of points) {
    if (p.y === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function segmentToLinePath(seg) {
  return seg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

function buildLinePaths(points) {
  return toSegments(points).map(segmentToLinePath);
}

function buildAreaPaths(points, baseline) {
  return toSegments(points).map((seg) => {
    const top = segmentToLinePath(seg);
    const last = seg[seg.length - 1];
    const first = seg[0];
    return `${top} L${last.x.toFixed(2)},${baseline.toFixed(2)} L${first.x.toFixed(2)},${baseline.toFixed(2)} Z`;
  });
}

// timeline: the /api/sky `timeline` array. bestWindow: report.bestWindow
// (may be null). sqmStops: the light-pollution legend's `stops` array
// (already fetched for the map legend — passed in rather than refetched).
function buildTimelineChart(timeline, bestWindow, sqmStops) {
  if (!timeline || timeline.length < 2) return null;
  const n = timeline.length;

  const cloudPoints = timeline.map((h, i) => ({
    x: xForIndex(i, n),
    y: h.cloudCover === null ? null : CLOUD_HEIGHT - (clamp(h.cloudCover, 0, 100) / 100) * CLOUD_HEIGHT,
    value: h.cloudCover,
  }));

  const sqmTop = CLOUD_HEIGHT + PANEL_GAP;
  const sqmPoints = timeline.map((h, i) => {
    const v = h.effectiveSqm;
    const y =
      v === null
        ? null
        : sqmTop +
          SQM_HEIGHT -
          ((clamp(v, SQM_DOMAIN[0], SQM_DOMAIN[1]) - SQM_DOMAIN[0]) / (SQM_DOMAIN[1] - SQM_DOMAIN[0])) * SQM_HEIGHT;
    return { x: xForIndex(i, n), y, value: v, colour: interpolateColour(v, sqmStops) };
  });

  let bestWindowRect = null;
  if (bestWindow?.start && bestWindow?.end) {
    const startIdx = timeline.findIndex((h) => h.time === bestWindow.start);
    const endIdx = timeline.findIndex((h) => h.time === bestWindow.end);
    if (startIdx !== -1 && endIdx !== -1) {
      const step = n > 1 ? (VIEW_WIDTH - PAD_X * 2) / (n - 1) : 0;
      const half = step / 2;
      const x0 = xForIndex(startIdx, n) - half;
      const x1 = xForIndex(endIdx, n) + half;
      bestWindowRect = { x: x0, width: x1 - x0, top: 0, height: sqmTop + SQM_HEIGHT };
    }
  }

  const moonTicks = [];
  for (let i = 1; i < n; i++) {
    const prev = timeline[i - 1].moonAltitude;
    const cur = timeline[i].moonAltitude;
    if (prev === null || prev === undefined || cur === null || cur === undefined) continue;
    if (prev <= 0 && cur > 0) moonTicks.push({ x: xForIndex(i, n), kind: "rise" });
    else if (prev > 0 && cur <= 0) moonTicks.push({ x: xForIndex(i, n), kind: "set" });
  }

  const xTicks = timeline
    .map((h, i) => ({ index: i, time: h.time, x: xForIndex(i, n) }))
    .filter((t) => t.index === 0 || t.index === n - 1 || t.index % 3 === 0);

  return {
    viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    cloud: {
      top: 0,
      height: CLOUD_HEIGHT,
      points: cloudPoints,
      linePaths: buildLinePaths(cloudPoints),
      areaPaths: buildAreaPaths(cloudPoints, CLOUD_HEIGHT),
    },
    sqm: {
      top: sqmTop,
      height: SQM_HEIGHT,
      points: sqmPoints,
      linePaths: buildLinePaths(sqmPoints),
    },
    axisTop: sqmTop + SQM_HEIGHT,
    bestWindowRect,
    moonTicks,
    xTicks,
  };
}

// Plain-text fallback so every value the chart shows is also reachable
// without hovering — the interaction spec's "tooltips enhance, never gate."
function buildTableRows(timeline) {
  if (!timeline) return [];
  return timeline.map((h) => ({
    time: h.time,
    cloudCover: h.cloudCover,
    effectiveSqm: h.effectiveSqm,
    moonAltitude: h.moonAltitude,
    clear: h.clear,
  }));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildTimelineChart,
    buildTableRows,
    interpolateColour,
    nearestIndex,
    xForIndex,
    VIEW_WIDTH,
    VIEW_HEIGHT,
    SQM_DOMAIN,
  };
}
