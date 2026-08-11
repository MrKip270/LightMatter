// LightMatter — shared test fixtures
//
// THE MOST IMPORTANT RULE IN THIS FILE:
// a fixture must be built the way production builds its data.
//
// While developing the light pollution feature, a throwaway fixture hardcoded
// `bestClearRun: { hours: 10 }` while also setting 95% average cloud cover.
// That state is physically impossible — you cannot have ten clear hours and
// 95% average cover — but the scoring code faithfully computed a number for it
// and reported a solidly overcast night as 99/100. The code was correct; the
// fixture was lying, and the test "passed" on a scenario production can never
// produce.
//
// So `night()` below runs the REAL clouds helpers over the REAL hourly array to
// derive its summary fields, exactly as sources/clouds.js does. If those
// helpers change, the fixtures change with them.

const { helpers: cloudHelpers } = require("../../backend/sources/clouds");

// Build a night of hourly cloud cover running 20:00 -> 05:00 local time,
// deriving every summary field from the hourly data.
//
// `cover` is an array of 10 percentages, one per hour.
function night(dateIso, cover, utcOffsetSeconds = -18000) {
  if (cover.length !== 10) {
    throw new Error("night() expects exactly 10 hourly values (20:00 -> 05:00)");
  }

  const day = dateIso.slice(0, 8);
  const nextDay = String(Number(dateIso.slice(8, 10)) + 1).padStart(2, "0");

  const times = ["20", "21", "22", "23"]
    .map((h) => `${dateIso}T${h}:00`)
    .concat(["00", "01", "02", "03", "04", "05"].map((h) => `${day}${nextDay}T${h}:00`));

  const hourly = times.map((time, i) => ({ time, cloudCover: cover[i] }));

  // Derived, not asserted — same helpers the real source uses.
  const run = cloudHelpers.longestClearRun(hourly);
  const usable = run.length >= cloudHelpers.MIN_USEFUL_RUN_HOURS;

  return {
    source: "Open-Meteo forecast",
    dataAvailable: true,
    location: {
      requested: { lat: 41.88, lon: -87.63 },
      used: { lat: 41.88, lon: -87.63 },
      timezone: "America/Chicago",
      utcOffsetSeconds,
    },
    night: {
      start: hourly[0].time,
      end: hourly[hourly.length - 1].time,
      hoursCounted: hourly.length,
      polarEdgeCase: false,
    },
    averageCloudCover: cloudHelpers.averageCloudCover(hourly),
    bestClearRun: usable
      ? { hours: run.length, start: run.start, end: run.end }
      : null,
    hourly,
  };
}

const CLEAR = new Array(10).fill(5);
const OVERCAST = new Array(10).fill(95);
const HALF = [5, 5, 5, 5, 95, 95, 95, 95, 95, 95]; // clear until midnight
const BROKEN = [40, 45, 50, 40, 45, 50, 40, 45, 50, 40]; // never clear, never solid

const lightPollution = (sqm) => ({
  source: "Falchi et al. 2016",
  dataAvailable: true,
  location: { lat: 0, lon: 0 },
  sqm,
});

const aurora = (probability) => ({
  source: "NOAA SWPC OVATION",
  dataAvailable: true,
  auroraProbability: probability,
});

// Real places, so tests read like scenarios rather than arithmetic.
const SITES = {
  cherrySprings: { lat: 41.6628, lon: -77.8164, sqm: 21.93 },
  chicago: { lat: 41.88, lon: -87.63, sqm: 17.15 },
  tromso: { lat: 69.6492, lon: 18.9553, sqm: 19.46 },
};

// Dates chosen for their moon phase — verified in moon.test.js.
const NEW_MOON_NIGHT = "2026-08-12";
const FULL_MOON_NIGHT = "2026-08-28";

module.exports = {
  night,
  lightPollution,
  aurora,
  CLEAR,
  OVERCAST,
  HALF,
  BROKEN,
  SITES,
  NEW_MOON_NIGHT,
  FULL_MOON_NIGHT,
};
