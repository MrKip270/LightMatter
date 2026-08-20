// LightMatter — cloud cover data source
//
// Pure data logic. See sources/aurora.js for why this is split from the route.

const suncalc = require("suncalc");

// Switched from Open-Meteo to WeatherAPI.com — Open-Meteo rate-limits by IP,
// and on Render that IP is shared with other tenants' traffic, so we were
// getting 429s from load that wasn't ours. WeatherAPI ties its (much higher)
// quota to WEATHERAPI_KEY instead, which fixes that at the root.
const WEATHERAPI_URL = "https://api.weatherapi.com/v1/forecast.json";

// --- Tuning knobs -----------------------------------------------------------
// Deliberately harsher than the meteorological "okta" convention, because faint
// targets (aurora, the Milky Way) wash out long before a forecaster would call
// the sky cloudy.
const CLEAR_MAX = 20; // 0-20%   -> good visibility
const PARTLY_MAX = 70; // 21-70% -> reduced to very reduced visibility
//                       71-100% -> low to no visibility

// A "usable" clear stretch has to be long enough to be worth going outside for.
const MIN_USEFUL_RUN_HOURS = 2;

// --- Pure helpers -----------------------------------------------------------

function cloudVerdict(percent) {
  if (percent <= CLEAR_MAX) return "Clear";
  if (percent <= PARTLY_MAX) return "Partly cloudy";
  return "Overcast";
}

function visibilityNote(verdict) {
  switch (verdict) {
    case "Clear":
      return "Good visibility";
    case "Clears overnight":
      return "Reduced visibility, but a clear window opens up later";
    case "Partly cloudy":
      return "Reduced to very reduced visibility";
    default:
      return "Low to no visibility";
  }
}

// A usable clear run can exist inside an otherwise cloudy night — that run is
// worth a "Clear" verdict for the WINDOW, but not for the night's own average.
// Calling the whole night "Clear" when it averages 64% cloud cover contradicts
// the average sitting right next to this word (see formatCloud in
// frontend/format.js) and the headline built from that same average in
// scoring.js's buildHeadline. "Clears overnight" says the true thing: mostly
// cloudy, with a real window later.
function verdictWithUsableWindow(average, hasUsableWindow) {
  const overall = cloudVerdict(average);
  return hasUsableWindow && overall !== "Clear" ? "Clears overnight" : overall;
}

// "2026-07-31T20:10" -> "2026-07-31T20:00"
// Sunset is 20:10, but the hourly array is labelled by hour START, so the entry
// we want is 20:00 (it covers 20:00-21:00, which contains 20:10).
function floorToHour(localIso) {
  return `${localIso.slice(0, 13)}:00`;
}

// Convert a UTC Date (from suncalc) to a naive local ISO string (the format
// Open-Meteo uses for its hourly time array). The inverse of localIsoToUtc in
// sky.js. We add the offset rather than subtract because we are going UTC→local.
function utcToLocalIso(utcDate, utcOffsetSeconds) {
  const localMs = utcDate.getTime() + utcOffsetSeconds * 1000;
  return new Date(localMs).toISOString().slice(0, 16);
}

// WeatherAPI's astro sunrise/sunset are 12-hour strings with no date ("06:26
// AM"), unlike Open-Meteo's full ISO timestamps. Combines with the forecast
// day's date to produce the same "YYYY-MM-DDTHH:MM" shape the rest of this
// file (and scoring.js's localIsoToUtc, which does `Date.parse(iso + ":00Z")`
// and therefore REQUIRES the "T" separator) already assumes everywhere.
//
// Returns null — rather than throwing — when the string doesn't match, which
// is deliberately the same "no time available" signal Open-Meteo gives with
// a null sunset/sunrise at true-polar latitudes. Not yet verified against a
// real polar response (WeatherAPI's polar-day/night wording is unconfirmed),
// but this keeps that case degrading instead of crashing if it turns up.
function parseAstroTime(dateStr, timeStr) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((timeStr ?? "").trim());
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2];
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  return `${dateStr}T${String(hour).padStart(2, "0")}:${minute}`;
}

// WeatherAPI has no raw utc_offset_seconds field (Open-Meteo did). Instead it
// gives localtime_epoch (a real UTC instant, in seconds) alongside localtime
// (the naive wall-clock string AT that instant) — so the offset is just the
// difference between the two, treating localtime as if it were UTC.
//
// localtime is truncated to the minute, so the raw difference can be off by
// up to 59 seconds. Real-world UTC offsets are always whole 15-minute
// increments, so rounding to the nearest 900s cancels that noise out exactly.
function computeUtcOffsetSeconds(localtime, localtimeEpoch) {
  const [datePart, timePart] = localtime.split(" ");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const rawOffsetSeconds = Math.round((localAsUtcMs - localtimeEpoch * 1000) / 1000);
  return Math.round(rawOffsetSeconds / 900) * 900;
}

// Pick the hourly entries inside [startIso, endIso], inclusive.
//
// The comparison is the subtle part. timezone=auto makes every timestamp a
// naive LOCAL string in a fixed layout, so plain string comparison sorts them
// chronologically. We never construct a Date, and therefore never risk
// JavaScript reinterpreting the location's local time as the SERVER's.
function selectHoursInWindow(times, cloudCovers, startIso, endIso) {
  const hours = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= startIso && times[i] <= endIso) {
      hours.push({ time: times[i], cloudCover: cloudCovers[i] });
    }
  }
  return hours;
}

// Longest unbroken run of hours at or below CLEAR_MAX.
//
// Averaging the whole night hides its shape: clear 21:00-23:00 then socked in
// until dawn averages to "partly cloudy", which would tell the user to stay
// home on a night they should go out for those three hours.
function longestClearRun(hours) {
  let best = { length: 0, start: null, end: null };
  let runStart = null;

  for (let i = 0; i <= hours.length; i++) {
    // Reading one past the end lets a run reaching the final hour close out
    // through the same code path as any other.
    //
    // The explicit null check matters: `null <= 20` is TRUE in JavaScript,
    // because null coerces to 0. Without it, a gap in the data would
    // masquerade as a perfectly clear sky.
    const isClear =
      i < hours.length &&
      hours[i].cloudCover !== null &&
      hours[i].cloudCover <= CLEAR_MAX;

    if (isClear && runStart === null) {
      runStart = i;
    } else if (!isClear && runStart !== null) {
      const length = i - runStart;
      if (length > best.length) {
        best = { length, start: hours[runStart].time, end: hours[i - 1].time };
      }
      runStart = null;
    }
  }

  return best;
}

// Hours with no reading are skipped rather than counted as zero.
function averageCloudCover(hours) {
  const known = hours.filter((hour) => hour.cloudCover !== null);
  if (known.length === 0) return null;
  const total = known.reduce((sum, hour) => sum + hour.cloudCover, 0);
  return Math.round(total / known.length);
}

// --- Cache --------------------------------------------------------------------
// Open-Meteo rate-limits by IP, and on a host like Render that IP is shared
// across many other apps' traffic — not just ours. Without a cache, every
// page load (and every candidate darksite.js's ring search probes) is its
// own fresh fetch, which is what tripped a 429 in production despite our own
// traffic being light. Mirrors auroratiles.js's grid cache: same TTL
// reasoning, same "cache the in-flight promise so concurrent callers share
// one fetch" trick, same short cooldown on failure so a burst of requests
// during an outage doesn't retry-storm Open-Meteo further.
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 30 * 1000;
// ~11km at the equator. Coarse enough that a darksite ring search (many
// points a few km apart) collapses onto one shared entry; fine enough that
// forecasts still differ location to location. A cache hit still reports the
// ORIGINAL cached call's `location.requested`, not the current caller's —
// an accepted tradeoff for the same reason auroratiles.js caches by whole
// grid rather than per exact point.
const ROUND_DEGREES = 0.1;

const cache = new Map(); // key -> { expiresAt, promise }

function cacheKey(lat, lon) {
  const rlat = (Math.round(lat / ROUND_DEGREES) * ROUND_DEGREES).toFixed(1);
  const rlon = (Math.round(lon / ROUND_DEGREES) * ROUND_DEGREES).toFixed(1);
  return `${rlat},${rlon}`;
}

async function getClouds(lat, lon) {
  const key = cacheKey(lat, lon);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = fetchClouds(lat, lon).catch((err) => {
    cache.set(key, { promise, expiresAt: Date.now() + FAILURE_COOLDOWN_MS });
    throw err;
  });

  cache.set(key, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
  return promise;
}

// --- The source --------------------------------------------------------------

async function fetchClouds(lat, lon) {
  const apiKey = process.env.WEATHERAPI_KEY;
  if (!apiKey) {
    throw new Error("WEATHERAPI_KEY is not configured");
  }

  const params = new URLSearchParams({
    key: apiKey,
    q: `${lat},${lon}`,
    days: "2", // tonight crosses midnight, so one day is not enough
    aqi: "no",
    alerts: "no",
  });

  const response = await fetch(`${WEATHERAPI_URL}?${params}`);
  if (!response.ok) {
    throw new Error(`WeatherAPI responded with status ${response.status}`);
  }
  const data = await response.json();

  const [dayToday, dayTomorrow] = data.forecast.forecastday;
  const utcOffset = computeUtcOffsetSeconds(
    data.location.localtime,
    data.location.localtime_epoch
  );

  const sunsetToday = parseAstroTime(dayToday.date, dayToday.astro?.sunset);
  const sunriseTomorrow = dayTomorrow
    ? parseAstroTime(dayTomorrow.date, dayTomorrow.astro?.sunrise)
    : null;

  // Polar edge case. Above the Arctic circle and below the Antarctic one, the
  // sun may not set or not rise. Tromsø - our own aurora default at 69.6N -
  // is inside that zone, so this is a real path.
  const isTruePolar = !sunsetToday || !sunriseTomorrow;

  // WeatherAPI splits hourly data per calendar day instead of one flat
  // 48-hour array like Open-Meteo, so we flatten it back into the same
  // parallel time/cloud arrays the rest of this function expects. Each
  // hour's "YYYY-MM-DD HH:MM" (space-separated) becomes "YYYY-MM-DDTHH:MM"
  // to match every other local timestamp this file produces — see
  // parseAstroTime's comment for why that separator is load-bearing.
  const allHours = [...dayToday.hour, ...(dayTomorrow ? dayTomorrow.hour : [])];
  const hourlyTimes = allHours.map((hour) => hour.time.replace(" ", "T"));
  const hourlyCloudCover = allHours.map((hour) => hour.cloud);

  // Compute astronomical twilight bounds. The sun must be 18° below the horizon
  // before sky is genuinely dark — this can be 60–90 min after sunset depending
  // on latitude and season. suncalc calls the start of that window "night" and
  // the end "nightEnd". Both are returned as UTC Dates.
  //
  // We use two separate getTimes() calls because the events fall on different
  // calendar days: "night" on the sunset day, "nightEnd" on the sunrise day.
  // Using the wrong day would return last night's or next night's value.
  //
  // suncalc returns an invalid Date (NaN) rather than null when the sun never
  // reaches 18° below the horizon (e.g. Tromsø in early summer). We check
  // isFinite so those near-polar cases fall through to the sunset/sunrise window.
  let twilightStart = null;
  let twilightEnd = null;

  if (!isTruePolar) {
    // suncalc uses the UTC calendar date of the Date you pass — the time within
    // the day doesn't matter. We need it on the LOCAL calendar date of the event,
    // so we use UTC noon on the date portion of each local string. This avoids
    // the off-by-one-day problem that arises when the UTC equivalent of a local
    // evening crosses midnight into the next UTC day (e.g. Chicago UTC-5:
    // local 20:10 = UTC 01:10 next day, so passing that UTC date to suncalc
    // would compute events for the wrong night entirely).
    const eveningTimes = suncalc.getTimes(
      new Date(`${sunsetToday.slice(0, 10)}T12:00:00Z`), lat, lon
    );
    const morningTimes = suncalc.getTimes(
      new Date(`${sunriseTomorrow.slice(0, 10)}T12:00:00Z`), lat, lon
    );

    if (eveningTimes.night && isFinite(eveningTimes.night.getTime())) {
      twilightStart = utcToLocalIso(eveningTimes.night, utcOffset);
    }
    if (morningTimes.nightEnd && isFinite(morningTimes.nightEnd.getTime())) {
      twilightEnd = utcToLocalIso(morningTimes.nightEnd, utcOffset);
    }
  }

  // Window priority:
  //   1. Astronomical twilight (sun 18° below horizon) — most accurate.
  //   2. Sunset/sunrise — fallback for near-polar summers where the sun never
  //      dips far enough for true astronomical night.
  //   3. First/last hourly entry — last resort for true polar (no sunset at all).
  const windowStart = isTruePolar
    ? hourlyTimes[0]
    : twilightStart
      ? floorToHour(twilightStart)
      : floorToHour(sunsetToday);
  const windowEnd = isTruePolar
    ? hourlyTimes[23]
    : twilightEnd
      ? floorToHour(twilightEnd)
      : floorToHour(sunriseTomorrow);

  const isPolarEdgeCase = isTruePolar || (!twilightStart && !twilightEnd);

  const nightHours = selectHoursInWindow(hourlyTimes, hourlyCloudCover, windowStart, windowEnd);

  const average = averageCloudCover(nightHours);

  const location = {
    requested: { lat, lon },
    // WeatherAPI snaps to its nearest station/city, so report what it
    // actually used.
    used: { lat: data.location.lat, lon: data.location.lon },
    timezone: data.location.tz_id,
    // Needed to turn our naive local timestamps back into real UTC instants,
    // which is what any astronomical calculation requires. The local strings
    // are perfect for comparing hours to each other, but useless to suncalc.
    utcOffsetSeconds: utcOffset,
  };

  // The request worked but there is nothing to report. NOT an error.
  if (average === null) {
    return {
      source: "WeatherAPI forecast",
      dataAvailable: false,
      location,
      verdict: null,
      visibility: "No cloud data available for this location.",
      averageCloudCover: null,
      clearestHour: null,
      bestClearRun: null,
      hourly: [],
    };
  }

  const clearest = nightHours
    .filter((hour) => hour.cloudCover !== null)
    .reduce(
      (best, hour) => (best === null || hour.cloudCover < best.cloudCover ? hour : best),
      null
    );
  const bestRun = longestClearRun(nightHours);
  const hasUsableWindow = bestRun.length >= MIN_USEFUL_RUN_HOURS;
  const verdict = verdictWithUsableWindow(average, hasUsableWindow);

  return {
    source: "WeatherAPI forecast",
    dataAvailable: true,
    location,
    night: {
      start: windowStart,
      end: windowEnd,
      sunset: sunsetToday,
      sunrise: sunriseTomorrow,
      astronomicalDusk: twilightStart,
      astronomicalDawn: twilightEnd,
      hoursCounted: nightHours.length,
      polarEdgeCase: isPolarEdgeCase,
    },
    verdict,
    visibility: visibilityNote(verdict),
    averageCloudCover: average,
    clearestHour: clearest
      ? { time: clearest.time, cloudCover: clearest.cloudCover }
      : null,
    bestClearRun: hasUsableWindow
      ? { hours: bestRun.length, start: bestRun.start, end: bestRun.end }
      : null,
    hourly: nightHours,
  };
}

module.exports = {
  getClouds,
  helpers: {
    cloudVerdict,
    visibilityNote,
    verdictWithUsableWindow,
    floorToHour,
    utcToLocalIso,
    selectHoursInWindow,
    longestClearRun,
    averageCloudCover,
    CLEAR_MAX,
    PARTLY_MAX,
    MIN_USEFUL_RUN_HOURS,
    // Test-only seam: clears the in-memory cache so tests don't leak state
    // into each other. Never used by production code paths.
    _resetCacheForTests() {
      cache.clear();
    },
  },
};
