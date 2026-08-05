// LightMatter — combined sky report
//
// The endpoint the whole project was aiming at: one request, one answer.
// It fans out to every source in parallel, then reduces them to
//   - a 0-100 score      ("how good is tonight, here?")
//   - per-target verdicts ("can I see the Milky Way? the aurora?")
//   - a headline sentence ("why is it that good or bad?")
//
// The score and the target verdicts are computed independently on purpose.
// They can disagree — a low score with "bright planets: likely" is a real and
// useful combination — and that disagreement is informative rather than a bug.
//
// This is also the PRD's primary test seam: every function below is pure, so
// tests feed it fake source objects with no server and no network.

const express = require("express");
const { getAurora } = require("../sources/aurora");
const { getClouds } = require("../sources/clouds");
const { getLightPollution } = require("../sources/lightpollution");
const { validateCoordinates } = require("./validate");

const router = express.Router();

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

// How dark the site is, independent of tonight's weather. Maps the useful part
// of the SQM range (16 = inner city, 22 = pristine) onto 0-1.
function darknessFactor(lightPollution) {
  if (!lightPollution || !lightPollution.dataAvailable) return null;
  return clamp((lightPollution.sqm - 16) / (22 - 16), 0, 1);
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
function computeScore(clouds, lightPollution, aurora) {
  const cloud = cloudFactor(clouds);
  const darkness = darknessFactor(lightPollution);

  // Without both, a number would be a guess dressed up as a measurement.
  if (cloud === null || darkness === null) return null;

  const base = 100 * cloud * darkness;

  const probability = aurora?.dataAvailable ? aurora.auroraProbability : 0;
  const auroraBonus = Math.min(20, probability / 5) * cloud;

  return Math.round(clamp(base + auroraBonus, 0, 100));
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

function targetVerdicts(clouds, lightPollution) {
  const ceiling = cloudCeiling(clouds);

  return TARGETS.map((target) => {
    if (!lightPollution || !lightPollution.dataAvailable) {
      return {
        name: target.name,
        verdict: "Unknown",
        reason: "No light pollution data for this location.",
        detail: target.detail,
      };
    }

    const sqm = lightPollution.sqm;

    if (sqm < target.minSqm) {
      return {
        name: target.name,
        verdict: "Not visible",
        reason: `Sky is too bright here (${sqm} mag/arcsec²; needs ${target.minSqm}).`,
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
function auroraVerdict(aurora, clouds, lightPollution) {
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

  // Aurora is faint and diffuse, so city glow kills it even when it is
  // technically overhead. Cap it in bright skies.
  if (lightPollution?.dataAvailable && lightPollution.sqm < 19.5 && verdict === "Likely") {
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
function buildHeadline(score, clouds, lightPollution) {
  if (score === null) {
    return "Not enough data to score tonight — see the individual sources below.";
  }

  const cloud = cloudFactor(clouds);
  const darkness = darknessFactor(lightPollution);
  const limitedByCloud = cloud < darkness;

  if (score >= 70) {
    return "Excellent conditions tonight — clear skies over a genuinely dark site.";
  }
  if (score >= 45) {
    return limitedByCloud
      ? "Decent night, but cloud will cut into it."
      : "Clear enough tonight, though local light pollution limits what you'll see.";
  }
  if (score >= 20) {
    return limitedByCloud
      ? "Poor viewing — cloud is the main problem tonight."
      : "Poor viewing — the sky here is too bright for much beyond the basics.";
  }
  return limitedByCloud
    ? "Not a night for it — cloud cover blocks nearly everything."
    : "Very limited — bright skies here leave only the Moon and brightest planets.";
}

// --- Assembly -----------------------------------------------------------------

// Unwrap an allSettled result into { data, error }, so the combining functions
// above never have to know about promise plumbing.
function unwrap(settled) {
  return settled.status === "fulfilled"
    ? { data: settled.value, error: null }
    : { data: null, error: settled.reason.message };
}

function buildReport(clouds, lightPollution, aurora) {
  const score = computeScore(clouds, lightPollution, aurora);

  return {
    score, // 0-100, or null when clouds or light pollution are missing
    headline: buildHeadline(score, clouds, lightPollution),
    targets: [
      ...targetVerdicts(clouds, lightPollution),
      auroraVerdict(aurora, clouds, lightPollution),
    ],
    factors: {
      cloud: cloudFactor(clouds),
      darkness: darknessFactor(lightPollution),
    },
  };
}

// --- The route ----------------------------------------------------------------
//   /api/sky?lat=41.88&lon=-87.63

router.get("/", async (req, res) => {
  const coords = validateCoordinates(req.query);
  if (coords.error) return res.status(400).json({ error: coords.error });

  const { lat, lon } = coords;

  // allSettled, not all — one dead source must degrade its own section only.
  // getLightPollution is synchronous, but Promise.resolve().then() folds it
  // into the same settled shape so the unwrapping below stays uniform.
  const [cloudsResult, lightResult, auroraResult] = await Promise.allSettled([
    getClouds(lat, lon),
    Promise.resolve().then(() => getLightPollution(lat, lon)),
    getAurora(lat, lon),
  ]);

  const clouds = unwrap(cloudsResult);
  const lightPollution = unwrap(lightResult);
  const aurora = unwrap(auroraResult);

  const report = buildReport(clouds.data, lightPollution.data, aurora.data);

  res.json({
    location: { lat, lon },
    ...report,
    // The raw sources ride along so the frontend can keep showing its detail
    // cards, and so a curious user can see where the verdict came from.
    sources: {
      clouds: clouds.data ?? { error: clouds.error },
      lightPollution: lightPollution.data ?? { error: lightPollution.error },
      aurora: aurora.data ?? { error: aurora.error },
    },
  });
});

module.exports = router;

// Exposed for unit tests: all pure, no network, no Express.
module.exports.helpers = {
  cloudFactor,
  darknessFactor,
  computeScore,
  cloudCeiling,
  targetVerdicts,
  auroraVerdict,
  buildHeadline,
  buildReport,
  TARGETS,
};
