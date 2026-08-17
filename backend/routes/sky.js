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
const { getMoon } = require("../sources/moon");
const { validateCoordinates } = require("./validate");
const scoring = require("../sources/scoring");
const { buildNightTimeline, buildReport } = scoring;

const router = express.Router();

// --- Assembly -----------------------------------------------------------------

// Unwrap an allSettled result into { data, error }, so the combining functions
// above never have to know about promise plumbing.
function unwrap(settled) {
  return settled.status === "fulfilled"
    ? { data: settled.value, error: null }
    : { data: null, error: settled.reason.message };
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
  const [cloudsResult, lightResult, auroraResult, moonResult] = await Promise.allSettled([
    getClouds(lat, lon),
    Promise.resolve().then(() => getLightPollution(lat, lon)),
    getAurora(lat, lon),
    Promise.resolve().then(() => getMoon(lat, lon)),
  ]);

  const clouds = unwrap(cloudsResult);
  const lightPollution = unwrap(lightResult);
  const aurora = unwrap(auroraResult);
  const moon = unwrap(moonResult);

  // Built after the fan-out because it needs cloud hours AND the site's
  // brightness before it can compute anything.
  const timeline = buildNightTimeline(clouds.data, lightPollution.data, lat, lon);

  const report = buildReport(
    clouds.data,
    lightPollution.data,
    aurora.data,
    moon.data,
    timeline
  );

  res.json({
    location: { lat, lon },
    ...report,
    // The raw sources ride along so the frontend can keep showing its detail
    // cards, and so a curious user can see where the verdict came from.
    sources: {
      clouds: clouds.data ?? { error: clouds.error },
      lightPollution: lightPollution.data ?? { error: lightPollution.error },
      aurora: aurora.data ?? { error: aurora.error },
      moon: moon.data ?? { error: moon.error },
    },
    timeline,
  });
});

module.exports = router;

// The scoring/combining logic itself lives in ../sources/scoring.js — a SOURCE
// file, not a route, so backend/sources/darksite.js can reuse it without a
// source depending on a route. Re-exported here under the same name so nothing
// that already does `require("../backend/routes/sky").helpers` had to change.
module.exports.helpers = scoring;
