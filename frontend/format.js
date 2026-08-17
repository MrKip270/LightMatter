// LightMatter — pure display formatting
//
// Same pattern as coords.js: no DOM access, so this file works in the browser
// (loaded by a <script> tag) and in Node (via require), which is what makes it
// testable. app.js cannot be tested this way — it touches the DOM at load time.
//
// Anything here turns data into something a person reads. Nothing here fetches,
// renders, or knows what a element is.

// Score band, brightest to darkest: white → pink → orange → crimson → blood.
//
// Quality is encoded by BRIGHTNESS along one warm ramp rather than by hue. A
// red/green scale clashes with the palette and fails for roughly 8% of men;
// a light-to-dark ramp survives both.
function scoreBand(score) {
  if (score === null || score === undefined) return "none";
  if (score >= 85) return "peak";
  if (score >= 70) return "good";
  if (score >= 45) return "fair";
  if (score >= 20) return "poor";
  return "bad";
}

// "2026-08-05T21:00" -> "9 PM"
//
// Slices the string rather than constructing a Date, deliberately. These
// timestamps are local to the SEARCHED location, not the viewer — handing one
// to new Date() would re-anchor a Chicago sunset to the reader's own timezone,
// so someone in London checking Chicago would see the wrong hours.
function formatHour(localIso) {
  if (!localIso) return "—";
  const hour = Number(localIso.slice(11, 13));
  if (Number.isNaN(hour)) return "—";
  const suffix = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12} ${suffix}`;
}

// Thousands separators for star counts. "2,957" reads instantly; "2957" does not.
function formatCount(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString();
}

// Cloud cover as a single readable phrase.
//
// A dash means the same thing everywhere else in this readout: a successful
// lookup with nothing to report. An upstream failure is a different fact —
// the forecast wasn't checked at all — so it gets its own phrase rather than
// collapsing into the same dash and reading as "clear skies" by omission.
function formatCloud(clouds) {
  if (!clouds) return "—";
  if (clouds.error) return "Unavailable — couldn’t reach the forecast";
  if (!clouds.dataAvailable) return "—";
  return `${clouds.averageCloudCover}% avg · ${clouds.verdict}`;
}

// Upcoming eclipse as one line. Eclipses are reported as a dated fact about a
// place, not drawn on the map — we hold eclipse TIMES, not ground tracks, so a
// path would have to be invented.
function formatEclipse(eclipse) {
  if (!eclipse) return null;
  const where = eclipse.visibleHere ? "visible here" : "not visible from here";
  return `${eclipse.type} in ${eclipse.daysAway}d · ${where}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { scoreBand, formatHour, formatCount, formatCloud, formatEclipse };
}
