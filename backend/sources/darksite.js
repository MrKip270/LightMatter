// LightMatter — nearest dark site search
//
// Two searches live here:
//   findNearestDarkSite         — nearest cell that is BOTH dark enough (meets
//                                  minSqm) AND a genuine improvement over the
//                                  query point's own darkness. Pure grid
//                                  search, synchronous, no network.
//   findNearestGoodWeatherDarkSite — same darkness-floor candidate pool, but
//                                  widened to the nearest K qualifying cells,
//                                  each scored the same way /api/sky scores
//                                  ANY point (cloud + moon + darkness, no
//                                  aurora), returning the nearest one that
//                                  scores strictly better tonight than the
//                                  query point itself would.
//
// Both searches share one invariant: they never recommend somewhere WORSE than
// where the user already is. Comparing against a fixed threshold alone doesn't
// guarantee that — a query point that already exceeds the threshold could still
// get "improved" onto a cell that merely clears the same threshold by less. So
// both functions look up the query point's own darkness (and, for the weather-
// aware search, its own real tonight-score) FIRST, and require candidates to
// beat it, not just clear a floor.
//
// Both share searchCandidates() below, which walks the light pollution grid
// (the same in-memory atlas the point lookup and tile renderer already use —
// see lightpollutiongrid.js) outward from the query cell in square "rings"
// (the natural shape for a row/column grid — see ringCells), collecting the
// nearest cells that meet the darkness floor (and, optionally, any additional
// per-cell qualifying predicate).

const { grid, meta, loadError } = require("./lightpollutiongrid");
const { getLightPollution } = require("./lightpollution");
const { getClouds } = require("./clouds");
const { darknessFactor, scoreTonight } = require("./scoring");

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

// The shared search: nearest `count` cells meeting minSqm (and, optionally,
// `qualifies(sqm)` — an extra per-cell gate), ascending by distance. Both
// public functions below are thin formatters over this.
//
// `qualifies` defaults to "anything that clears the floor qualifies" — the
// original behaviour, still exactly what findNearestGoodWeatherDarkSite wants
// for its candidate POOL (unchanged by this fix). findNearestDarkSite passes a
// stricter predicate: also darker than the query point itself.
function searchCandidates(lat, lon, minSqm, count, qualifies = () => true) {
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
      if (!qualifies(sqm)) continue;

      const center = cellCenter(row, col);
      const distanceKm = haversineKm(lat, lon, center.lat, center.lon);
      const item = { lat: center.lat, lon: center.lon, distanceKm, sqm };

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

function findNearestDarkSite(
  lat,
  lon,
  minSqm = DEFAULT_MIN_SQM,
  { lookupOrigin = getLightPollution } = {}
) {
  if (loadError) {
    const err = new Error(loadError);
    err.statusCode = 503; // our problem, not the caller's
    throw err;
  }

  const query = { lat, lon };

  // The query point's own darkness is the bar every candidate must clear.
  // Comparing via darknessFactor (not raw sqm) means two cells that are both
  // already at the atlas's ~22.0 practical ceiling read as equally dark, so a
  // hundredth-of-a-magnitude difference at the ceiling never triggers a
  // pointless "farther but technically darker" relocation.
  const origin = lookupOrigin(lat, lon);
  const originSqm = origin?.dataAvailable ? origin.sqm : null;
  const originDataAvailable = originSqm !== null;

  // No concrete bar to clear — degrade to the floor-only behaviour rather
  // than refusing to search at all.
  const qualifies = originDataAvailable
    ? (sqm) => darknessFactor(sqm) > darknessFactor(originSqm)
    : () => true;

  const search = searchCandidates(lat, lon, minSqm, 1, qualifies);

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
      originSqm,
      originDataAvailable,
      message: originDataAvailable
        ? `Nothing within ${MAX_SEARCH_RADIUS_KM} km is both above ${minSqm} mag/arcsec² and darker than here.`
        : `No cell within ${MAX_SEARCH_RADIUS_KM} km reaches ${minSqm} mag/arcsec².`,
    };
  }

  return {
    query,
    minSqm,
    dataAvailable: true,
    found: true,
    originSqm,
    originDataAvailable,
    distanceKm: Number(best.distanceKm.toFixed(1)),
    location: { lat: best.lat, lon: best.lon },
    lightPollution: getLightPollution(best.lat, best.lon),
  };
}

// Like findNearestDarkSite, but widened to the nearest `candidateCount`
// dark-enough cells (unchanged pool — see searchCandidates' default
// `qualifies`), each scored the same way /api/sky scores ANY point (cloud +
// moon + darkness; aurora deliberately excluded — see scoring.js), returning
// the NEAREST one that scores strictly better tonight than the query point
// itself. If nothing in the checked pool beats the query point, this returns
// found:false rather than recommending the least-bad option anyway.
//
// `fetchWeather` defaults to the real getClouds, but is overridable so tests
// can exercise the selection logic without a network call — the same seam
// scoring.js's buildReport uses (take already-fetched source data).
async function findNearestGoodWeatherDarkSite(
  lat,
  lon,
  minSqm = DEFAULT_MIN_SQM,
  {
    candidateCount = DEFAULT_WEATHER_CANDIDATES,
    fetchWeather = getClouds,
    lookupOrigin = getLightPollution,
  } = {}
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
      candidatesChecked: 0,
      message: `No cell within ${MAX_SEARCH_RADIUS_KM} km reaches ${minSqm} mag/arcsec².`,
    };
  }

  // The origin's own forecast rides in the SAME allSettled batch as every
  // candidate's — one round of parallelism, not an extra round trip first.
  const settled = await Promise.allSettled([
    fetchWeather(lat, lon),
    ...search.candidates.map((c) => fetchWeather(c.lat, c.lon)),
  ]);
  const [originSettled, ...candidateSettled] = settled;

  const originClouds = originSettled.status === "fulfilled" ? originSettled.value : null;
  const originLightPollution = lookupOrigin(lat, lon);
  const originScore = scoreTonight(originClouds, originLightPollution, lat, lon);
  const originScoreAvailable = originScore !== null;

  // allSettled, not all — one candidate's dead forecast must not sink the
  // others. A candidate whose forecast failed scores null (cloudFactor(null)
  // is null, so scoreTonight is null too) and therefore simply cannot win.
  const evaluated = search.candidates.map((candidate, i) => {
    const settledForecast = candidateSettled[i];
    const clouds = settledForecast.status === "fulfilled" ? settledForecast.value : null;
    const score = scoreTonight(clouds, { dataAvailable: true, sqm: candidate.sqm }, candidate.lat, candidate.lon);
    return { candidate, clouds, score };
  });

  // Candidates are already nearest-first, so the first strict improvement in
  // iteration order IS the nearest one that beats tonight's own sky. When the
  // origin's own score couldn't be computed, there is nothing concrete to
  // beat, so any candidate with a real score qualifies — the same "degrade to
  // floor-only" posture findNearestDarkSite takes for the same reason.
  const match = evaluated.find(
    (c) => c.score !== null && (originScore === null || c.score > originScore)
  );

  if (!match) {
    return {
      query,
      minSqm,
      dataAvailable: true,
      found: false,
      candidatesChecked: evaluated.length,
      originScore,
      originScoreAvailable,
      message: `No cell among the ${evaluated.length} nearest dark-enough sites scores better than here tonight.`,
    };
  }

  const location = { lat: match.candidate.lat, lon: match.candidate.lon };

  return {
    query,
    minSqm,
    dataAvailable: true,
    found: true,
    candidatesChecked: evaluated.length,
    distanceKm: Number(match.candidate.distanceKm.toFixed(1)),
    location,
    score: match.score,
    originScore,
    originScoreAvailable,
    lightPollution: getLightPollution(location.lat, location.lon),
    weather: match.clouds ?? { dataAvailable: false, error: "Forecast unavailable for this site." },
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
  },
};
