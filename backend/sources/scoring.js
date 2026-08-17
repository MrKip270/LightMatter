// LightMatter — sky scoring
//
// Pure combining logic: turn cloud cover + light pollution + moon + aurora into
// a 0-100 score, target verdicts, and a headline. No Express, no network — this
// is what makes it reusable from anywhere that needs "the same number the user
// would see", not just the /api/sky route.
//
// Originally lived inside routes/sky.js. Moved here so backend/sources/darksite.js
// (a SOURCE file) could reuse it without importing from a ROUTE file, which would
// invert this project's "sources hold data logic; routes hold HTTP wrappers"
// convention. routes/sky.js re-exports everything below under the same `helpers`
// shape it always has, so nothing downstream of that route needed to change.
//
// The score and the target verdicts are computed independently on purpose.
// They can disagree — a low score with "bright planets: likely" is a real and
// useful combination — and that disagreement is informative rather than a bug.

const { getMoon, effectiveSqm, helpers: moonHelpers } = require("./moon");
const { helpers: cloudHelpers } = require("./clouds");
const { helpers: lightHelpers } = require("./lightpollution");

// Our night hours are naive LOCAL strings ("2026-08-05T21:00"), which is what
// makes comparing them to each other safe. Astronomy needs the opposite: a real
// UTC instant. Parsing as UTC then subtracting the location's offset converts
// between the two without ever relying on the server's own timezone.
function localIsoToUtc(localIso, utcOffsetSeconds) {
  return new Date(Date.parse(`${localIso}:00Z`) - utcOffsetSeconds * 1000);
}

// Walk the night hour by hour, combining cloud cover with moonlight to get the
// sky brightness actually available in that hour.
//
// This is the join that makes the whole report honest. Cloud cover alone says
// "clear at 2 AM"; light pollution alone says "dark site"; the moon alone says
// "full". Only together do they say "clear and dark from 3 AM, once the moon
// sets" — which is the sentence a person can act on.
function buildNightTimeline(clouds, lightPollution, lat, lon) {
  if (!clouds?.dataAvailable || !clouds.hourly?.length) return null;

  const offset = clouds.location?.utcOffsetSeconds ?? 0;
  const siteSqm = lightPollution?.dataAvailable ? lightPollution.sqm : null;

  return clouds.hourly.map((hour) => {
    const utc = localIsoToUtc(hour.time, offset);
    const moon = getMoon(lat, lon, utc);
    const sqm = effectiveSqm(siteSqm, moon.phase, moon.altitudeNow);

    return {
      time: hour.time,
      cloudCover: hour.cloudCover,
      clear: hour.cloudCover !== null && hour.cloudCover <= cloudHelpers.CLEAR_MAX,
      moonAltitude: moon.altitudeNow,
      effectiveSqm: sqm === null ? null : Number(sqm.toFixed(2)),
      moonPenalty:
        siteSqm === null ? null : Number((siteSqm - sqm).toFixed(2)),
    };
  });
}

// Longest contiguous stretch that is BOTH clear and effectively moonless.
// Falls back to the longest merely-clear stretch when the moon is up all night,
// flagging that it did so — "your best window is moonlit" is still useful.
function findBestWindow(timeline) {
  if (!timeline) return null;

  const runOf = (predicate) => {
    let best = { hours: 0, start: null, end: null };
    let startIndex = null;

    for (let i = 0; i <= timeline.length; i++) {
      const ok = i < timeline.length && predicate(timeline[i]);
      if (ok && startIndex === null) startIndex = i;
      else if (!ok && startIndex !== null) {
        const hours = i - startIndex;
        if (hours > best.hours) {
          best = { hours, start: timeline[startIndex].time, end: timeline[i - 1].time };
        }
        startIndex = null;
      }
    }
    return best;
  };

  const moonless = runOf(
    (hour) =>
      hour.clear &&
      (hour.moonPenalty === null ||
        hour.moonPenalty <= moonHelpers.MOONLESS_PENALTY_THRESHOLD)
  );

  // `moonFree` means moonlight is not meaningfully affecting the view — which
  // is not the same as "the moon is down". In a city the moon can be 45 degrees
  // up and still contribute 0.01 magnitudes, because the sky is already far
  // brighter than the moon can make it.
  if (moonless.hours >= cloudHelpers.MIN_USEFUL_RUN_HOURS) {
    return { ...moonless, moonFree: true };
  }

  const clear = runOf((hour) => hour.clear);
  if (clear.hours >= cloudHelpers.MIN_USEFUL_RUN_HOURS) {
    return { ...clear, moonFree: false };
  }

  return null;
}

// Mean sky brightness across a set of hours.
//
// Averaged in LINEAR FLUX, then converted back — the same rule that governed
// the atlas downsampling and the moonlight model. Averaging magnitudes directly
// would compute a geometric mean and report the night as darker than it was.
function meanSqm(values) {
  if (values.length === 0) return null;
  const meanFlux =
    values.reduce((sum, sqm) => sum + Math.pow(10, -0.4 * sqm), 0) / values.length;
  return -2.5 * Math.log10(meanFlux);
}

// The sky brightness to judge the night by.
//
// Scoped to the window we're actually advertising, not the whole night. Scoring
// the single darkest hour while telling the user "your window is 10 hours" would
// be quietly dishonest — it promises the best moment as though it lasted all
// night. Mean across the advertised window keeps the number and the sentence
// describing the same thing.
function bestEffectiveSqm(timeline, window, lightPollution) {
  if (!timeline) return lightPollution?.dataAvailable ? lightPollution.sqm : null;

  let hours = timeline.filter((hour) => hour.effectiveSqm !== null);
  if (window) {
    hours = hours.filter(
      (hour) => hour.time >= window.start && hour.time <= window.end
    );
  }
  if (hours.length === 0) return null;

  return meanSqm(hours.map((hour) => hour.effectiveSqm));
}

// --- Targets ------------------------------------------------------------------
// Each target is gated by how dark the sky must be. Thresholds are in SQM
// (magnitudes per square arc-second); higher is darker.
//
// Ordered brightest-target-first, so the list reads as a natural "what's still
// possible here" ladder.
const TARGETS = [
  {
    name: "Bright planets",
    minSqm: 0, // effectively always: Jupiter sits ~250x above an inner-city limit
    detail: "Venus, Jupiter, Mars and Saturn outshine even inner-city skyglow.",
  },
  {
    name: "Major constellations",
    minSqm: 18.5,
    detail: "The brighter stars that outline familiar patterns.",
  },
  {
    name: "Milky Way",
    minSqm: 20.5,
    detail: "Diffuse, so it is the first thing skyglow destroys.",
  },
  {
    name: "Faint stars & deep sky",
    minSqm: 21.3,
    detail: "Star clusters and nebulae visible to the unaided eye.",
  },
];

// --- Scoring factors ----------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// How much of the sky is actually accessible tonight. 0 = solid overcast.
//
// Two candidate readings, and we take the better: the plain inverse of average
// cover, and the fraction of the night occupied by the longest clear run. A
// night that is half clear then half overcast averages to 50%, but if those
// clear hours are contiguous they are far more useful than the average implies.
function cloudFactor(clouds) {
  if (!clouds || !clouds.dataAvailable) return null;

  const fromAverage = 1 - clouds.averageCloudCover / 100;

  if (clouds.bestClearRun && clouds.night?.hoursCounted) {
    const runFraction = clouds.bestClearRun.hours / clouds.night.hoursCounted;
    return clamp(Math.max(fromAverage, runFraction), 0, 1);
  }

  return clamp(fromAverage, 0, 1);
}

// How dark the sky actually is tonight. Maps the useful part of the SQM range
// (16 = inner city, 22 = pristine) onto 0-1.
//
// Takes an EFFECTIVE sqm — the site's baseline already adjusted for moonlight —
// rather than the raw light pollution reading. That single change is what stops
// the report promising the Milky Way on a full-moon night.
function darknessFactor(sqm) {
  if (sqm === null || sqm === undefined) return null;
  return clamp((sqm - 16) / (22 - 16), 0, 1);
}

// Score is MULTIPLICATIVE, not a weighted sum. That is the important modelling
// choice here: a weighted average would let a pristine dark site score
// respectably under solid overcast, because darkness would prop up the number.
// Multiplying means either factor near zero drags the result to zero, which is
// the truth — the darkest sky in the world is worth nothing under cloud.
//
// Aurora is added rather than multiplied, because it is a bonus event and not a
// precondition. It is scaled by cloudFactor so it cannot inflate a night you
// physically cannot see.
// The scoring formula itself, taking already-computed factors.
//
// Extracted so that BOTH scores run through identical arithmetic. The potential
// score is not a separate formula — it is this one with perfect weather and no
// moon substituted in. Writing it twice would let the two definitions drift
// apart, and then "58 tonight out of 92 possible" would stop meaning anything.
function scoreFrom(cloud, darkness, auroraProbability = 0) {
  // Without both, a number would be a guess dressed up as a measurement.
  if (cloud === null || darkness === null) return null;

  const base = 100 * cloud * darkness;
  const auroraBonus = Math.min(20, auroraProbability / 5) * cloud;

  return Math.round(clamp(base + auroraBonus, 0, 100));
}

function computeScore(clouds, effectiveSky, aurora) {
  return scoreFrom(
    cloudFactor(clouds),
    darknessFactor(effectiveSky),
    aurora?.dataAvailable ? aurora.auroraProbability : 0
  );
}

// What this location gives you on a perfect night: clear skies, no moon.
//
// Deliberately excludes the aurora bonus. Aurora depends on solar activity that
// varies over an 11-year cycle, so folding it in would make "potential" mean
// something that changes year to year — the opposite of a stable property of a
// place. This number should only move when the light pollution does.
function computePotentialScore(lightPollution) {
  const baseline = lightPollution?.dataAvailable ? lightPollution.sqm : null;
  return scoreFrom(1, darknessFactor(baseline), 0);
}

// The real tonight-score for an arbitrary site, given already-fetched clouds and
// light pollution — the same pipeline the /api/sky route runs for its own query
// point, reusable for ANY coordinate. This is what lets darksite.js compare a
// candidate's actual score against the origin's, rather than a coarse proxy.
//
// Aurora is deliberately never a parameter here: every caller of this function
// wants a comparison that only reflects a stable, quickly-computable pipeline —
// see the "potential score" rationale above for why aurora is excluded from
// anything meant to compare or rank places rather than describe one instant.
function scoreTonight(clouds, lightPollution, lat, lon) {
  const timeline = buildNightTimeline(clouds, lightPollution, lat, lon);
  const window = findBestWindow(timeline);
  const effectiveSky =
    bestEffectiveSqm(timeline, window, lightPollution) ??
    (lightPollution?.dataAvailable ? lightPollution.sqm : null);
  return computeScore(clouds, effectiveSky, null);
}

// How many stars you can actually expect to see, tonight versus at this site's
// best. This is the most concrete thing the whole report produces — "about 80
// stars" lands in a way that "17.1 magnitudes per square arc-second" never will.
//
// Computed from the EFFECTIVE sky, so moonlight reduces the count exactly as
// city glow does. Because star counts roughly triple per magnitude, a full moon
// costing 2.5 magnitudes doesn't halve the count — it cuts it by around 90%.
function buildStarEstimate(effectiveSky, baselineSqm) {
  if (effectiveSky === null || effectiveSky === undefined) return null;

  const tonightMag = lightHelpers.nakedEyeLimitingMagnitude(effectiveSky);
  const tonightCount = lightHelpers.visibleStarCount(tonightMag);

  const bestMag =
    baselineSqm === null ? null : lightHelpers.nakedEyeLimitingMagnitude(baselineSqm);
  const bestCount = bestMag === null ? null : lightHelpers.visibleStarCount(bestMag);

  return {
    // Faintest star visible tonight, and roughly how many that means.
    limitingMagnitude: Number(tonightMag.toFixed(1)),
    visibleTonight: tonightCount,
    // Same, on a clear moonless night at this site.
    bestLimitingMagnitude: bestMag === null ? null : Number(bestMag.toFixed(1)),
    visibleAtBest: bestCount,
    // For scale: a pristine sky (SQM 22) is the practical ceiling anywhere.
    visibleUnderPristineSky: lightHelpers.visibleStarCount(
      lightHelpers.nakedEyeLimitingMagnitude(22)
    ),
  };
}

// Short label for the potential score, describing the SITE rather than tonight.
function describePotential(score) {
  if (score === null) return null;
  if (score >= 85) return "Exceptional dark-sky site";
  if (score >= 65) return "Good dark site";
  if (score >= 45) return "Usable on a clear night";
  if (score >= 25) return "Limited by local light pollution";
  return "Heavily light polluted";
}

// --- Verdicts -----------------------------------------------------------------

// Cloud cover gates everything, so it decides how far a verdict can be
// downgraded. Returns a function that caps any optimistic verdict.
function cloudCeiling(clouds) {
  const cloud = cloudFactor(clouds);
  if (cloud === null) return "Unknown";
  if (cloud < 0.2) return "Not visible"; // effectively solid cover
  if (cloud < 0.55) return "Possible"; // broken cloud; no promises
  return "Likely";
}

const RANK = { "Not visible": 0, Unknown: 1, Possible: 2, Likely: 3 };

// The weakest link wins: a target is only as visible as the worst of its
// constraints allows.
function weakest(a, b) {
  return RANK[a] <= RANK[b] ? a : b;
}

function targetVerdicts(clouds, effectiveSky, moonPenalty = 0) {
  const ceiling = cloudCeiling(clouds);

  return TARGETS.map((target) => {
    if (effectiveSky === null || effectiveSky === undefined) {
      return {
        name: target.name,
        verdict: "Unknown",
        reason: "No light pollution data for this location.",
        detail: target.detail,
      };
    }

    const sqm = effectiveSky;

    if (sqm < target.minSqm) {
      // Naming the CAUSE matters. "Too bright" is not actionable; "too bright
      // because of the Moon" means come back in two weeks, while "too bright
      // because of the city" means drive somewhere else. Same verdict, opposite
      // advice.
      const blamesMoon = moonPenalty >= 0.5 && sqm + moonPenalty >= target.minSqm;
      return {
        name: target.name,
        verdict: "Not visible",
        reason: blamesMoon
          ? `Moonlight is washing this out (${moonPenalty.toFixed(1)} mag of skyglow); the site itself is dark enough.`
          : `Sky is too bright here (${sqm.toFixed(2)} mag/arcsec²; needs ${target.minSqm}).`,
        detail: target.detail,
      };
    }

    // Dark enough in principle — now let the weather have its say.
    const verdict = weakest("Likely", ceiling);
    const reason =
      verdict === "Likely"
        ? "Dark enough here, and the sky should be clear enough."
        : verdict === "Not visible"
          ? "Dark enough here, but cloud cover blocks it tonight."
          : verdict === "Possible"
            ? "Dark enough here, but broken cloud may get in the way."
            : "Dark enough here; cloud forecast unavailable.";

    return { name: target.name, verdict, reason, detail: target.detail };
  });
}

// Aurora is its own thing: it needs darkness AND clear sky AND the sun to
// cooperate, so it does not fit the fixed-threshold ladder above.
function auroraVerdict(aurora, clouds, effectiveSky) {
  if (!aurora || !aurora.dataAvailable) {
    return { name: "Aurora", verdict: "Unknown", reason: "Aurora data unavailable." };
  }

  const probability = aurora.auroraProbability;
  const ceiling = cloudCeiling(clouds);

  if (probability < 5) {
    return {
      name: "Aurora",
      verdict: "Not visible",
      reason: `Aurora probability is only ${probability}% at this latitude tonight.`,
    };
  }

  const fromProbability = probability >= 30 ? "Likely" : "Possible";
  let verdict = weakest(fromProbability, ceiling);

  // Aurora is faint and diffuse, so skyglow kills it even when it is
  // technically overhead. Uses the EFFECTIVE sky, so a full moon suppresses the
  // aurora verdict exactly as city glow would — which is physically right, both
  // are just background light drowning a faint diffuse source.
  if (effectiveSky !== null && effectiveSky < 19.5 && verdict === "Likely") {
    verdict = "Possible";
  }

  const reason =
    verdict === "Not visible"
      ? `${probability}% chance overhead, but cloud blocks the view.`
      : `${probability}% chance overhead tonight.`;

  return { name: "Aurora", verdict, reason };
}

// --- Headline -----------------------------------------------------------------

// One sentence explaining the score. The valuable part is naming the LIMITING
// FACTOR — "42" tells you nothing actionable, but "clouds are the problem"
// means come back tomorrow, while "city glow is the problem" means drive.
function buildHeadline(score, clouds, effectiveSky, moonPenalty = 0) {
  if (score === null) {
    return "Not enough data to score tonight — see the individual sources below.";
  }

  const cloud = cloudFactor(clouds);
  const darkness = darknessFactor(effectiveSky);
  const limitedByCloud = cloud < darkness;

  // Three possible culprits now, not two. The moon is called out separately
  // because it is the only one that is guaranteed to fix itself on a known
  // schedule — worth saying so.
  const moonIsTheProblem = !limitedByCloud && moonPenalty >= 1.0;

  if (score >= 70) {
    // Even a good night can be moon-limited. Saying "no significant moonlight"
    // unconditionally here was wrong: a full moon over a pristine site still
    // scores in the 70s, and the user deserves to know it would be better in
    // two weeks.
    return moonPenalty >= 1.0
      ? `Very good tonight — clear and dark, though the Moon is costing you about ${moonPenalty.toFixed(1)} magnitudes.`
      : "Excellent conditions tonight — clear, dark, and no significant moonlight.";
  }
  if (score >= 45) {
    if (limitedByCloud) return "Decent night, but cloud will cut into it.";
    if (moonIsTheProblem) {
      return `Clear tonight, but the Moon is adding ${moonPenalty.toFixed(1)} magnitudes of skyglow — this site is much better near new moon.`;
    }
    return "Clear enough tonight, though local light pollution limits what you'll see.";
  }
  if (score >= 20) {
    if (limitedByCloud) return "Poor viewing — cloud is the main problem tonight.";
    if (moonIsTheProblem) {
      return "Poor viewing — moonlight is washing out an otherwise dark sky.";
    }
    return "Poor viewing — the sky here is too bright for much beyond the basics.";
  }
  return limitedByCloud
    ? "Not a night for it — cloud cover blocks nearly everything."
    : "Very limited — bright skies here leave only the Moon and brightest planets.";
}

// --- Assembly -----------------------------------------------------------------

function buildReport(clouds, lightPollution, aurora, moon, timeline) {
  // Order matters: pick the window first, then judge the sky across THAT
  // window. Computing the brightness first and the window second would let the
  // two describe different slices of the night.
  const bestWindow = findBestWindow(timeline);

  const effectiveSky =
    bestEffectiveSqm(timeline, bestWindow, lightPollution) ??
    (lightPollution?.dataAvailable ? lightPollution.sqm : null);

  const baseline = lightPollution?.dataAvailable ? lightPollution.sqm : null;
  const moonPenalty =
    baseline !== null && effectiveSky !== null
      ? Math.max(0, baseline - effectiveSky)
      : 0;

  const score = computeScore(clouds, effectiveSky, aurora);
  const potentialScore = computePotentialScore(lightPollution);

  return {
    score, // 0-100 for TONIGHT, or null when clouds or light pollution are missing
    // What the site is capable of on a clear, moonless night. Depends only on
    // light pollution, so it is a stable property of the place — the number to
    // compare locations by, and the one that says whether a trip is worth
    // planning at all.
    potentialScore,
    potentialLabel: describePotential(potentialScore),
    headline: buildHeadline(score, clouds, effectiveSky, moonPenalty),
    bestWindow,
    sky: {
      baselineSqm: baseline, // what the site is capable of
      effectiveSqm: effectiveSky === null ? null : Number(effectiveSky.toFixed(2)),
      moonPenaltyMagnitudes: Number(moonPenalty.toFixed(2)),
    },
    stars: buildStarEstimate(effectiveSky, baseline),
    targets: [
      ...targetVerdicts(clouds, effectiveSky, moonPenalty),
      auroraVerdict(aurora, clouds, effectiveSky),
    ],
    factors: {
      cloud: cloudFactor(clouds),
      darkness: darknessFactor(effectiveSky),
    },
  };
}

module.exports = {
  cloudFactor,
  darknessFactor,
  scoreFrom,
  computeScore,
  computePotentialScore,
  scoreTonight,
  describePotential,
  buildStarEstimate,
  cloudCeiling,
  targetVerdicts,
  auroraVerdict,
  buildHeadline,
  buildReport,
  buildNightTimeline,
  findBestWindow,
  bestEffectiveSqm,
  localIsoToUtc,
  TARGETS,
};
