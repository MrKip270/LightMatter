// LightMatter — nearest dark site search
//
// Two searches live here:
//   findNearestDarkSite         — nearest cell meeting a target SQM. Pure grid
//                                  search, synchronous, no network.
//   findNearestGoodWeatherDarkSite — same darkness search, but widened to the
//                                  nearest K qualifying cells, each checked
//                                  against tonight's forecast so the answer is
//                                  a site actually worth driving to tonight,
//                                  not just the nearest dark one under cloud.
//
// Both share searchCandidates() below, which walks the light pollution grid
// (the same in-memory atlas the point lookup and tile renderer already use —
// see lightpollutiongrid.js) outward from the query cell in square "rings"
// (the natural shape for a row/column grid — see ringCells), collecting the
// nearest cells that meet the darkness threshold.

const { grid, meta, loadError } = require("./lightpollutiongrid");
const { getLightPollution } = require("./lightpollution");
const { getClouds } = require("./clouds");

const KM_PER_DEGREE = 111; // matches the constant already used for resolutionKm
const EARTH_RADIUS_KM = 6371;

const DEFAULT_MIN_SQM = 21.3; // describeSky()'s "Rural" band
const MAX_SEARCH_RADIUS_KM = 1500; // generous; nowhere on the grid should need more

// How many dark-enough candidates to check tonight's forecast for. Each check
// is an Open-Meteo call, so this is a real cost/latency knob, not free — 8
// comfortably spans a handful of genuinely different weather cells at the
// grid's ~7km spacing without excessive fan-out.
const DEFAULT_WEATHER_CANDIDATES = 8;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two lat/lon points, in km.
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function cellCenter(row, col) {
  return {
    lat: meta.originY + meta.resY * (row + 0.5),
    lon: meta.originX + meta.resX * (col + 0.5),
  };
}

function rowColFor(lat, lon) {
  return {
    row: Math.floor((lat - meta.originY) / meta.resY),
    col: Math.floor((lon - meta.originX) / meta.resX),
  };
}

// The cheapest real-world distance a single ring step could possibly cover at
// this latitude. Longitude compresses toward the poles (a factor of cos(lat));
// latitude does not. The true minimum for a ring is whichever axis is
// currently the "cheap" one, since a ring cell can reach the ring using only
// that axis.
function kmPerRingStep(lat) {
  const rowKm = Math.abs(meta.resY) * KM_PER_DEGREE;
  const colKm = meta.resX * KM_PER_DEGREE * Math.max(Math.cos(toRad(lat)), 0.01);
  return Math.min(rowKm, colKm);
}

// Every (row, col) forming the square ring at Chebyshev distance `radius`
// from the center cell. Radius 0 is just the center cell itself.
function* ringCells(row0, col0, radius) {
  if (radius === 0) {
    yield [row0, col0];
    return;
  }
  for (let col = col0 - radius; col <= col0 + radius; col++) {
    yield [row0 - radius, col];
    yield [row0 + radius, col];
  }
  for (let row = row0 - radius + 1; row <= row0 + radius - 1; row++) {
    yield [row, col0 - radius];
    yield [row, col0 + radius];
  }
}

// Insertion into a small distance-sorted array. `count` stays tiny (single
// digits), so this beats sorting the whole candidate set on every insert.
function insertSorted(list, item) {
  let i = list.length;
  list.push(item);
  while (i > 0 && list[i - 1].distanceKm > item.distanceKm) {
    list[i] = list[i - 1];
    i--;
  }
  list[i] = item;
}

// The shared search: nearest `count` cells meeting minSqm, ascending by
// distance. Both public functions below are thin formatters over this.
function searchCandidates(lat, lon, minSqm, count) {
  const { row: row0, col: col0 } = rowColFor(lat, lon);

  if (col0 < 0 || col0 >= meta.width || row0 < 0 || row0 >= meta.height) {
    return { outsideExtent: true, candidates: [] };
  }

  const perStepKm = kmPerRingStep(lat);
  // Bounded twice: by real-world distance, and (in case perStepKm is tiny
  // near the poles) by the grid's own size, so a pathological threshold can
  // never turn this into an unbounded scan.
  const maxRadius = Math.min(
    Math.ceil(MAX_SEARCH_RADIUS_KM / perStepKm),
    Math.max(meta.width, meta.height)
  );

  const candidates = []; // ascending by distanceKm, capped at `count`

  for (let radius = 0; radius <= maxRadius; radius++) {
    // Once we have `count` candidates, nothing farther out than the current
    // worst of them could possibly displace it — the same early-stop logic
    // as the single-nearest search, generalized to the Kth-best distance.
    if (candidates.length >= count) {
      const worst = candidates[candidates.length - 1].distanceKm;
      if (radius * perStepKm > worst) break;
    }

    for (const [row, col] of ringCells(row0, col0, radius)) {
      if (row < 0 || row >= meta.height || col < 0 || col >= meta.width) continue;

      const raw = grid[row * meta.width + col];
      if (raw === meta.noData) continue;

      const sqm = raw / meta.scale;
      if (sqm < minSqm) continue;

      const center = cellCenter(row, col);
      const distanceKm = haversineKm(lat, lon, center.lat, center.lon);
      const item = { lat: center.lat, lon: center.lon, distanceKm };

      if (candidates.length < count) {
        insertSorted(candidates, item);
      } else if (distanceKm < candidates[candidates.length - 1].distanceKm) {
        insertSorted(candidates, item);
        candidates.pop();
      }
    }
  }

  return { outsideExtent: false, candidates };
}

function findNearestDarkSite(lat, lon, minSqm = DEFAULT_MIN_SQM) {
  if (loadError) {
    const err = new Error(loadError);
    err.statusCode = 503; // our problem, not the caller's
    throw err;
  }

  const query = { lat, lon };
  const search = searchCandidates(lat, lon, minSqm, 1);

  if (search.outsideExtent) {
    return {
      query,
      minSqm,
      dataAvailable: false,
      message: "No light pollution data for this location (the atlas covers 85N to 60S).",
    };
  }

  const best = search.candidates[0];
  if (!best) {
    return {
      query,
      minSqm,
      dataAvailable: true,
      found: false,
      message: `No cell within ${MAX_SEARCH_RADIUS_KM} km reaches ${minSqm} mag/arcsec².`,
    };
  }

  return {
    query,
    minSqm,
    dataAvailable: true,
    found: true,
    distanceKm: Number(best.distanceKm.toFixed(1)),
    location: { lat: best.lat, lon: best.lon },
    lightPollution: getLightPollution(best.lat, best.lon),
  };
}

// Deliberately harsher than "usable" — reuses clouds.js's own verdict, which
// already promotes a night with a long enough clear run to "Clear" even if
// the whole-night average looks partly cloudy. A site worth a drive should
// mean the same thing here as it does on the main report.
function isGoodWeather(clouds) {
  return Boolean(clouds && clouds.dataAvailable && clouds.verdict === "Clear");
}

// Like findNearestDarkSite, but widened to the nearest `candidateCount`
// qualifying cells and checked against tonight's forecast, returning the
// NEAREST one that is actually clear — not just dark.
//
// `fetchWeather` defaults to the real getClouds, but is overridable so tests
// can exercise the selection logic (nearest-clear-wins, degrade-on-failure,
// fall-back-when-nothing-clears) without a network call, the same seam
// sky.js uses (buildReport takes already-fetched source data).
async function findNearestGoodWeatherDarkSite(
  lat,
  lon,
  minSqm = DEFAULT_MIN_SQM,
  { candidateCount = DEFAULT_WEATHER_CANDIDATES, fetchWeather = getClouds } = {}
) {
  if (loadError) {
    const err = new Error(loadError);
    err.statusCode = 503;
    throw err;
  }

  const query = { lat, lon };
  const search = searchCandidates(lat, lon, minSqm, candidateCount);

  if (search.outsideExtent) {
    return {
      query,
      minSqm,
      dataAvailable: false,
      message: "No light pollution data for this location (the atlas covers 85N to 60S).",
    };
  }

  if (search.candidates.length === 0) {
    return {
      query,
      minSqm,
      dataAvailable: true,
      found: false,
      message: `No cell within ${MAX_SEARCH_RADIUS_KM} km reaches ${minSqm} mag/arcsec².`,
    };
  }

  // allSettled, not all — one candidate's dead forecast must not sink the
  // others; it just gets treated as not-clear (see isGoodWeather).
  const forecasts = await Promise.allSettled(
    search.candidates.map((c) => fetchWeather(c.lat, c.lon))
  );

  const evaluated = search.candidates.map((candidate, i) => {
    const settled = forecasts[i];
    const clouds = settled.status === "fulfilled" ? settled.value : null;
    return { candidate, clouds, weatherGood: isGoodWeather(clouds) };
  });

  // Candidates are already nearest-first, so the first good-weather match
  // in iteration order IS the nearest clear site — no re-sorting needed.
  const match = evaluated.find((c) => c.weatherGood) ?? evaluated[0];
  const weatherMatched = match.weatherGood;
  const location = { lat: match.candidate.lat, lon: match.candidate.lon };

  return {
    query,
    minSqm,
    dataAvailable: true,
    found: true,
    weatherMatched,
    candidatesChecked: evaluated.length,
    distanceKm: Number(match.candidate.distanceKm.toFixed(1)),
    location,
    lightPollution: getLightPollution(location.lat, location.lon),
    weather: match.clouds ?? { dataAvailable: false, error: "Forecast unavailable for this site." },
    message: weatherMatched
      ? undefined
      : `No clear weather among the ${evaluated.length} nearest dark-enough sites tonight; showing the closest anyway.`,
  };
}

module.exports = {
  findNearestDarkSite,
  findNearestGoodWeatherDarkSite,
  DEFAULT_MIN_SQM,
  DEFAULT_WEATHER_CANDIDATES,
  MAX_SEARCH_RADIUS_KM,
  helpers: {
    haversineKm,
    cellCenter,
    rowColFor,
    kmPerRingStep,
    ringCells,
    isGoodWeather,
  },
};
