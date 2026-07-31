// LightMatter — cloud cover route
//
// Data source: Open-Meteo forecast API (no API key required).
// Given coordinates, it returns hour-by-hour cloud cover plus the local
// sunrise/sunset times. We slice out the hours between tonight's sunset and
// tomorrow's sunrise — the only hours a stargazer actually cares about — and
// reduce them to a plain-language verdict, per the PRD's output model.

const express = require("express");

const router = express.Router();

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// --- Tuning knobs -----------------------------------------------------------
// Kaleb's thresholds. Deliberately harsher than the meteorological "okta"
// convention, because faint targets (aurora, the Milky Way) wash out long
// before a weather forecaster would call the sky cloudy.
// Expect to revisit these once light pollution and moon phase join the score.
const CLEAR_MAX = 20; // 0-20%   -> good visibility
const PARTLY_MAX = 70; // 21-70% -> reduced to very reduced visibility
//                       71-100% -> low to no visibility

// A "usable" clear stretch has to be long enough to be worth going outside for.
const MIN_USEFUL_RUN_HOURS = 2;

// --- Pure helpers -----------------------------------------------------------
// These are separated out on purpose. They take plain inputs and return plain
// outputs with no network access, which makes them the easy unit-test targets
// the PRD's testing section calls "per-source normalizers."

// Turn a cloud percentage into one of our three verdicts.
function cloudVerdict(percent) {
  if (percent <= CLEAR_MAX) return "Clear";
  if (percent <= PARTLY_MAX) return "Partly cloudy";
  return "Overcast";
}

// The human-facing meaning of each verdict.
function visibilityNote(verdict) {
  switch (verdict) {
    case "Clear":
      return "Good visibility";
    case "Partly cloudy":
      return "Reduced to very reduced visibility";
    default:
      return "Low to no visibility";
  }
}

// Round a local timestamp down to the top of its hour.
//   "2026-07-31T20:10"  ->  "2026-07-31T20:00"
//
// Why: sunset is 20:10, but the hourly array is labelled by hour START, so the
// entry we want is "20:00" (it covers 20:00-21:00, which contains 20:10).
// Slicing at 13 characters keeps "YYYY-MM-DDTHH" and we re-attach ":00".
function floorToHour(localIso) {
  return `${localIso.slice(0, 13)}:00`;
}

// Pick the hourly entries that fall inside [startIso, endIso], inclusive.
//
// The comparison here is the subtle part. Because timezone=auto makes every
// timestamp a naive LOCAL string in a fixed "YYYY-MM-DDTHH:mm" layout, plain
// string comparison sorts them chronologically — "2026-08-01T00:00" really is
// > "2026-07-31T23:00" alphabetically. So we never construct a Date, and
// therefore never risk JavaScript silently reinterpreting the location's local
// time as the SERVER's local time. That bug is invisible in development (when
// both happen to match) and wrong in production.
//
// Kept as its own function taking explicit start/end so a future "sunset to 2am"
// or user-chosen window is a one-line change at the call site.
function selectHoursInWindow(times, cloudCovers, startIso, endIso) {
  const hours = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= startIso && times[i] <= endIso) {
      hours.push({ time: times[i], cloudCover: cloudCovers[i] });
    }
  }
  return hours;
}

// Find the longest unbroken run of hours at or below CLEAR_MAX.
//
// Why bother: averaging the whole night hides the shape of it. A night that is
// clear 21:00-23:00 then socked in until dawn averages out to "partly cloudy",
// which would tell the user to stay home on a night they should absolutely go
// out for those three hours. The average answers "how is the night overall";
// this answers "is there a window", which is the question that changes plans.
function longestClearRun(hours) {
  let best = { length: 0, start: null, end: null };
  let runStart = null;

  for (let i = 0; i <= hours.length; i++) {
    // Reading one past the end (hours[length] is undefined) lets a run that
    // reaches the final hour get closed out by the same code path as any other,
    // instead of needing a duplicated check after the loop.
    //
    // The explicit null check matters: `null <= 20` is TRUE in JavaScript,
    // because null coerces to 0. Without this guard, a gap in the data would
    // masquerade as a perfectly clear sky — the worst possible failure mode
    // for this app.
    const isClear =
      i < hours.length &&
      hours[i].cloudCover !== null &&
      hours[i].cloudCover <= CLEAR_MAX;

    if (isClear && runStart === null) {
      runStart = i;
    } else if (!isClear && runStart !== null) {
      const length = i - runStart;
      if (length > best.length) {
        best = {
          length,
          start: hours[runStart].time,
          end: hours[i - 1].time,
        };
      }
      runStart = null;
    }
  }

  return best;
}

// Average cloud cover across a set of hours, rounded to a whole percent.
// Hours with no reading are skipped rather than counted as zero. Returns null
// if there is nothing to average, which the route treats as "no data".
function averageCloudCover(hours) {
  const known = hours.filter((hour) => hour.cloudCover !== null);
  if (known.length === 0) return null;
  const total = known.reduce((sum, hour) => sum + hour.cloudCover, 0);
  return Math.round(total / known.length);
}

// --- The route ---------------------------------------------------------------
// Mounted at /api/clouds, so the full URL is:
//   /api/clouds?lat=41.88&lon=-87.63

router.get("/", async (req, res) => {
  // 1. Read and default the coordinates. Same defaults as the aurora route so
  //    the two sources describe the same place when called bare.
  const lat = Number(req.query.lat ?? 70);
  const lon = Number(req.query.lon ?? 19);

  // 2. Validate before spending a network call on garbage input.
  if (
    Number.isNaN(lat) ||
    Number.isNaN(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return res
      .status(400)
      .json({ error: "lat must be -90..90 and lon must be -180..180" });
  }

  try {
    // 3. Build the query string with URLSearchParams rather than by gluing
    //    strings together. It handles escaping for us, and it keeps each
    //    parameter readable as a named decision instead of URL noise.
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      hourly: "cloud_cover",
      daily: "sunrise,sunset",
      timezone: "auto", // makes every returned timestamp local to the location
      forecast_days: "2", // tonight crosses midnight, so one day is not enough
    });

    const response = await fetch(`${OPEN_METEO_URL}?${params}`);
    if (!response.ok) {
      throw new Error(`Open-Meteo responded with status ${response.status}`);
    }
    const data = await response.json();

    // 4. Work out tonight's window: today's sunset -> tomorrow's sunrise.
    //    Index 0 is today, index 1 is tomorrow — that is why we asked for two
    //    forecast days.
    const sunsetToday = data.daily?.sunset?.[0] ?? null;
    const sunriseTomorrow = data.daily?.sunrise?.[1] ?? null;

    // 5. Polar edge case. Above the Arctic circle and below the Antarctic one,
    //    the sun may not set (polar day) or not rise (polar night) at all, and
    //    Open-Meteo reports null for the missing event. Tromsø — our own aurora
    //    default, at 69.6N — is inside that zone, so this is a real path, not a
    //    hypothetical. Rather than crash or silently return an empty night, we
    //    fall back to the whole local day and flag it so the frontend can say so.
    const isPolarEdgeCase = !sunsetToday || !sunriseTomorrow;

    const windowStart = isPolarEdgeCase
      ? data.hourly.time[0]
      : floorToHour(sunsetToday);
    const windowEnd = isPolarEdgeCase
      ? data.hourly.time[23]
      : floorToHour(sunriseTomorrow);

    const nightHours = selectHoursInWindow(
      data.hourly.time,
      data.hourly.cloud_cover,
      windowStart,
      windowEnd
    );

    // 6. Reduce the window to the numbers the frontend needs.
    const average = averageCloudCover(nightHours);

    // 6b. No-data path. Open-Meteo's model covers the globe, but a location can
    //     still come back with an empty window or null readings (unsupported
    //     cell, or a gap in the model run). That is NOT an error — the request
    //     succeeded, we simply have nothing to report. So we answer 200 with an
    //     explicit "unavailable" shape rather than a 502, and the frontend shows
    //     "No cloud data" for this section while every other source carries on.
    //     Distinguishing "broken" from "nothing to say" is what lets the PRD's
    //     independent-degradation rule actually work.
    if (average === null) {
      return res.json({
        source: "Open-Meteo forecast",
        dataAvailable: false,
        location: {
          requested: { lat, lon },
          used: { lat: data.latitude, lon: data.longitude },
          timezone: data.timezone,
        },
        verdict: null,
        visibility: "No cloud data available for this location.",
        averageCloudCover: null,
        clearestHour: null,
        bestClearRun: null,
        hourly: [],
      });
    }

    const clearest = nightHours
      .filter((hour) => hour.cloudCover !== null)
      .reduce(
        (best, hour) => (best === null || hour.cloudCover < best.cloudCover ? hour : best),
        null
      );
    const bestRun = longestClearRun(nightHours);

    // 7. The headline verdict keys off the BEST usable window, not the mean —
    //    see longestClearRun above for why. If there is no run long enough to
    //    be worth the trip, fall back to describing the night as a whole.
    const hasUsableWindow = bestRun.length >= MIN_USEFUL_RUN_HOURS;
    const verdict = hasUsableWindow ? "Clear" : cloudVerdict(average);

    // 8. Return a small, normalized payload. Note we echo back the coordinates
    //    Open-Meteo actually used: it snaps to its nearest model grid cell, so
    //    41.88 came back as 41.879498. Reporting the snapped value keeps us
    //    honest about where the measurement is really from — the same reason
    //    the aurora route reports NOAA's 1-degree grid cell.
    res.json({
      source: "Open-Meteo forecast",
      dataAvailable: true,
      location: {
        requested: { lat, lon },
        used: { lat: data.latitude, lon: data.longitude },
        timezone: data.timezone,
      },
      night: {
        start: windowStart,
        end: windowEnd,
        sunset: sunsetToday,
        sunrise: sunriseTomorrow,
        hoursCounted: nightHours.length,
        polarEdgeCase: isPolarEdgeCase,
      },
      verdict, // Clear | Partly cloudy | Overcast
      visibility: visibilityNote(verdict),
      averageCloudCover: average, // percent, 0-100
      clearestHour: clearest
        ? { time: clearest.time, cloudCover: clearest.cloudCover }
        : null,
      bestClearRun: hasUsableWindow
        ? { hours: bestRun.length, start: bestRun.start, end: bestRun.end }
        : null,
      hourly: nightHours, // full detail, so the frontend can chart it later
    });
  } catch (err) {
    // 9. Resilience (PRD): one dead source must not take down the response.
    //    We fail this route cleanly; the combined endpoint will later treat a
    //    502 here as "clouds unavailable" and still report everything else.
    res
      .status(502)
      .json({ error: "Could not fetch cloud data", detail: err.message });
  }
});

module.exports = router;

// Also expose the pure helpers for testing. An Express router is a function
// object, so we can hang extra properties off it without disturbing how
// server.js uses it. This lets tests import the normalizers directly and feed
// them a captured API response, with no server and no network — exactly the
// "per-source normalizer" unit tests the PRD calls for.
module.exports.helpers = {
  cloudVerdict,
  visibilityNote,
  floorToHour,
  selectHoursInWindow,
  longestClearRun,
  averageCloudCover,
  CLEAR_MAX,
  PARTLY_MAX,
  MIN_USEFUL_RUN_HOURS,
};
