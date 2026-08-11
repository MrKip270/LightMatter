// Tests for the combined sky report.
//
// This is the PRD's primary test seam: feed known inputs to the combining
// logic and assert the resulting score and verdicts, without asserting HOW it
// computed them. Every function under test here is pure — no Express, no
// network — which is the whole reason routes and sources were split apart.

const test = require("node:test");
const assert = require("node:assert/strict");

const { helpers: h } = require("../backend/routes/sky");
const f = require("./helpers/fixtures");

function report(cloudFixture, sqm, site, auroraFixture = null) {
  const light = sqm === null ? null : f.lightPollution(sqm);
  const timeline = h.buildNightTimeline(cloudFixture, light, site.lat, site.lon);
  return h.buildReport(cloudFixture, light, auroraFixture, null, timeline);
}

// --- Timezone conversion ------------------------------------------------------

test("localIsoToUtc converts a location's local time to a real instant", () => {
  // Chicago in summer is UTC-5. 21:00 local is 02:00 UTC the next day.
  const utc = h.localIsoToUtc("2026-08-05T21:00", -18000);
  assert.equal(utc.toISOString(), "2026-08-06T02:00:00.000Z");

  // Tokyo is UTC+9. 21:00 local is 12:00 UTC the SAME day.
  const tokyo = h.localIsoToUtc("2026-08-05T21:00", 32400);
  assert.equal(tokyo.toISOString(), "2026-08-05T12:00:00.000Z");
});

test("localIsoToUtc does not depend on the server's own timezone", () => {
  // This is the bug the naive `new Date(localString)` approach would introduce:
  // the result would shift depending on where the SERVER runs. Converting
  // through an explicit offset makes it deterministic everywhere.
  const utc = h.localIsoToUtc("2026-01-15T23:00", 0);
  assert.equal(utc.toISOString(), "2026-01-15T23:00:00.000Z");
});

// --- Factors ------------------------------------------------------------------

test("cloudFactor spans 0 to 1 and rewards contiguous clear hours", () => {
  assert.ok(h.cloudFactor(f.night("2026-08-12", f.CLEAR)) > 0.9, "clear night");
  assert.ok(h.cloudFactor(f.night("2026-08-12", f.OVERCAST)) < 0.1, "overcast night");

  // A night that is clear for the first four hours then socked in averages to
  // 59% cover, but those four contiguous hours are far more useful than the
  // average implies — so the factor uses the better of the two readings.
  const half = f.night("2026-08-12", f.HALF);
  assert.ok(
    h.cloudFactor(half) >= 0.4,
    "a real clear window beats what the average alone would suggest"
  );
});

test("cloudFactor returns null rather than guessing when data is missing", () => {
  assert.equal(h.cloudFactor(null), null);
  assert.equal(h.cloudFactor({ dataAvailable: false }), null);
});

test("darknessFactor maps the useful SQM range onto 0-1", () => {
  assert.equal(h.darknessFactor(16), 0, "floor");
  assert.equal(h.darknessFactor(22), 1, "ceiling");
  assert.ok(h.darknessFactor(15) === 0, "clamped below");
  assert.ok(h.darknessFactor(23) === 1, "clamped above");
  assert.equal(h.darknessFactor(null), null);
});

// --- Scoring ------------------------------------------------------------------

test("the score is MULTIPLICATIVE, so either factor can veto the night", () => {
  // The central modelling decision. A weighted sum would let a pristine site
  // score respectably under solid overcast, because darkness would prop the
  // number up — and the app would tell someone to drive four hours to stand
  // under a cloud.
  const darkAndOvercast = h.scoreFrom(0.05, 0.99);
  const brightAndClear = h.scoreFrom(0.95, 0.19);

  assert.ok(darkAndOvercast < 10, `pristine site under cloud scores ${darkAndOvercast}`);
  assert.ok(brightAndClear < 25, `clear city night scores ${brightAndClear}`);

  // A weighted average of the same factors would have produced ~52 and ~57.
  const wouldHaveBeen = Math.round(100 * ((0.05 + 0.99) / 2));
  assert.ok(
    darkAndOvercast < wouldHaveBeen / 3,
    `multiplicative (${darkAndOvercast}) is far below a weighted sum (${wouldHaveBeen})`
  );
});

test("score is bounded to 0-100 even with a large aurora bonus", () => {
  assert.equal(h.scoreFrom(1, 1, 100), 100, "capped at 100");
  assert.equal(h.scoreFrom(0, 0, 0), 0, "floored at 0");
  assert.ok(h.scoreFrom(1, 1, 100) <= 100);
});

test("score is null when a required input is missing", () => {
  // A number produced from partial data would be a guess dressed as a
  // measurement. Better to say nothing.
  assert.equal(h.scoreFrom(null, 0.9), null);
  assert.equal(h.scoreFrom(0.9, null), null);
});

// --- Potential score ----------------------------------------------------------

test("potential score is stable across every weather and moon condition", () => {
  // The defining property: it describes the PLACE, not the night. If this ever
  // varies with conditions, the second score has lost its meaning.
  const site = f.SITES.cherrySprings;
  const conditions = [
    ["clear, new moon", f.night(f.NEW_MOON_NIGHT, f.CLEAR)],
    ["clear, full moon", f.night(f.FULL_MOON_NIGHT, f.CLEAR)],
    ["overcast", f.night(f.NEW_MOON_NIGHT, f.OVERCAST)],
    ["half clear", f.night(f.NEW_MOON_NIGHT, f.HALF)],
  ];

  const scores = conditions.map(([, clouds]) => report(clouds, site.sqm, site).potentialScore);

  assert.ok(scores.every((s) => s === scores[0]), `all identical, got ${scores.join(", ")}`);
  assert.ok(scores[0] > 90, "Cherry Springs is an exceptional site regardless of tonight");
});

test("potential score deliberately excludes the aurora bonus", () => {
  // Aurora tracks an 11-year solar cycle. Including it would make a number
  // meant to be a stable property of a place drift year to year.
  const site = f.SITES.tromso;
  const clouds = f.night(f.NEW_MOON_NIGHT, f.CLEAR);

  const withoutAurora = report(clouds, site.sqm, site, null);
  const withAurora = report(clouds, site.sqm, site, f.aurora(90));

  assert.equal(
    withoutAurora.potentialScore,
    withAurora.potentialScore,
    "potential ignores the aurora reading"
  );
  assert.ok(
    withAurora.score > withoutAurora.score,
    "but tonight's score does reflect it"
  );
});

test("potential score is EXACTLY the darkness mapping, with no bonus of any kind", () => {
  // The test above only proves potential ignores the aurora FIXTURE. It would
  // still pass if the code hardcoded a bonus internally — which a mutation test
  // proved, by hardcoding one and watching the suite stay green.
  //
  // Pinning the value exactly closes that hole: potential must equal perfect
  // weather times darkness, and nothing else.
  for (const sqm of [16, 17.15, 19.46, 21.3, 21.93, 22]) {
    const expected = Math.round(100 * h.darknessFactor(sqm));
    assert.equal(
      h.computePotentialScore(f.lightPollution(sqm)),
      expected,
      `SQM ${sqm}: potential must be exactly 100 x darknessFactor, no additions`
    );
  }
  assert.equal(h.computePotentialScore(null), null);
  assert.equal(h.computePotentialScore({ dataAvailable: false }), null);
});

test("tonight's score never exceeds potential, except via the aurora bonus", () => {
  const site = f.SITES.cherrySprings;
  for (const cover of [f.CLEAR, f.OVERCAST, f.HALF, f.BROKEN]) {
    const r = report(f.night(f.NEW_MOON_NIGHT, cover), site.sqm, site);
    assert.ok(
      r.score <= r.potentialScore + 1, // +1 for rounding
      `score ${r.score} must not exceed potential ${r.potentialScore}`
    );
  }
});

test("potential separates a good site on a bad night from a bad site", () => {
  // The exact comparison the second score exists to enable.
  const dark = report(
    f.night(f.NEW_MOON_NIGHT, f.OVERCAST),
    f.SITES.cherrySprings.sqm,
    f.SITES.cherrySprings
  );
  const bright = report(
    f.night(f.NEW_MOON_NIGHT, f.CLEAR),
    f.SITES.chicago.sqm,
    f.SITES.chicago
  );

  assert.ok(dark.score < 15, "clouded-out dark site scores low tonight");
  assert.ok(bright.score < 25, "clear city night also scores low tonight");
  assert.ok(
    dark.potentialScore > bright.potentialScore + 50,
    "but only one of them is worth returning to"
  );
});

// --- Moonlight integration ----------------------------------------------------

test("a full moon meaningfully lowers the score at a dark site", () => {
  const site = f.SITES.cherrySprings;
  const newMoon = report(f.night(f.NEW_MOON_NIGHT, f.CLEAR), site.sqm, site);
  const fullMoon = report(f.night(f.FULL_MOON_NIGHT, f.CLEAR), site.sqm, site);

  assert.ok(
    newMoon.score - fullMoon.score > 25,
    `new moon ${newMoon.score} vs full moon ${fullMoon.score}`
  );
  assert.ok(fullMoon.sky.moonPenaltyMagnitudes > 1, "penalty is recorded");
  assert.equal(newMoon.sky.moonPenaltyMagnitudes, 0, "no penalty at new moon");
});

test("a full moon barely affects a city, where the sky is already bright", () => {
  const site = f.SITES.chicago;
  const newMoon = report(f.night(f.NEW_MOON_NIGHT, f.CLEAR), site.sqm, site);
  const fullMoon = report(f.night(f.FULL_MOON_NIGHT, f.CLEAR), site.sqm, site);

  assert.ok(
    Math.abs(newMoon.score - fullMoon.score) <= 3,
    `city scores barely move: ${newMoon.score} vs ${fullMoon.score}`
  );
});

test("a full moon flips the Milky Way to Not visible at a dark site", () => {
  const site = f.SITES.cherrySprings;
  const verdictFor = (r, name) => r.targets.find((t) => t.name === name).verdict;

  const newMoon = report(f.night(f.NEW_MOON_NIGHT, f.CLEAR), site.sqm, site);
  const fullMoon = report(f.night(f.FULL_MOON_NIGHT, f.CLEAR), site.sqm, site);

  assert.equal(verdictFor(newMoon, "Milky Way"), "Likely");
  assert.equal(verdictFor(fullMoon, "Milky Way"), "Not visible");

  // Bright point sources survive what diffuse ones do not.
  assert.equal(verdictFor(fullMoon, "Bright planets"), "Likely");
});

test("a moon-blocked target blames the moon, not the site", () => {
  // Same verdict, opposite advice: "come back in two weeks" versus "drive
  // somewhere else". Naming the cause is the useful part.
  const site = f.SITES.cherrySprings;
  const fullMoon = report(f.night(f.FULL_MOON_NIGHT, f.CLEAR), site.sqm, site);
  const milkyWay = fullMoon.targets.find((t) => t.name === "Milky Way");

  assert.match(milkyWay.reason, /moonlight/i, `got: ${milkyWay.reason}`);
});

// --- Best window --------------------------------------------------------------

test("best window finds the clear stretch on a partly cloudy night", () => {
  const site = f.SITES.cherrySprings;
  const r = report(f.night(f.NEW_MOON_NIGHT, f.HALF), site.sqm, site);

  assert.ok(r.bestWindow, "a window exists");
  assert.equal(r.bestWindow.hours, 4, "the four clear hours before midnight");
  assert.equal(r.bestWindow.moonFree, true, "and the moon is down");
});

test("no window is reported when the night is solidly overcast", () => {
  const site = f.SITES.cherrySprings;
  const r = report(f.night(f.NEW_MOON_NIGHT, f.OVERCAST), site.sqm, site);
  assert.equal(r.bestWindow, null);
});

test("a persistently broken sky yields no usable window", () => {
  // Never fully clear, never fully overcast — the case a simple average would
  // call "partly cloudy" and leave the user guessing.
  const site = f.SITES.cherrySprings;
  const r = report(f.night(f.NEW_MOON_NIGHT, f.BROKEN), site.sqm, site);
  assert.equal(r.bestWindow, null, "no run of genuinely clear hours");
});

test("moonFree means moonlight is harmless, not that the moon is down", () => {
  // In a city the moon can be high and still contribute ~0.1 magnitudes,
  // because the sky is already brighter than the moon can make it.
  const r = report(
    f.night(f.FULL_MOON_NIGHT, f.CLEAR),
    f.SITES.chicago.sqm,
    f.SITES.chicago
  );
  assert.equal(r.bestWindow.moonFree, true, "full moon up, but irrelevant here");
});

test("REGRESSION: brightness is averaged over the advertised window", () => {
  // The bug: effective SQM was the single DARKEST hour of the night, while the
  // report advertised a ten-hour window. That scored the best moment as though
  // it lasted all night, inflating a full-moon night at Cherry Springs from 57
  // to 74. The fix scopes the average to the window actually being offered.
  const site = f.SITES.cherrySprings;
  const r = report(f.night(f.FULL_MOON_NIGHT, f.CLEAR), site.sqm, site);

  const timeline = h.buildNightTimeline(
    f.night(f.FULL_MOON_NIGHT, f.CLEAR),
    f.lightPollution(site.sqm),
    site.lat,
    site.lon
  );
  const darkestHour = Math.max(...timeline.map((hour) => hour.effectiveSqm));

  assert.ok(
    r.sky.effectiveSqm < darkestHour - 0.2,
    `window mean (${r.sky.effectiveSqm}) must be brighter than the single best ` +
      `hour (${darkestHour}) — otherwise we are quietly reporting the best moment ` +
      `as if it lasted all night`
  );
});

// --- Target verdicts ----------------------------------------------------------

test("targets are gated by the sky brightness each one needs", () => {
  const verdicts = (sqm) =>
    Object.fromEntries(
      h.targetVerdicts(f.night(f.NEW_MOON_NIGHT, f.CLEAR), sqm).map((t) => [t.name, t.verdict])
    );

  const pristine = verdicts(21.9);
  assert.equal(pristine["Milky Way"], "Likely");
  assert.equal(pristine["Faint stars & deep sky"], "Likely");

  const city = verdicts(17.15);
  assert.equal(city["Bright planets"], "Likely", "planets always survive");
  assert.equal(city["Milky Way"], "Not visible");
  assert.equal(city["Major constellations"], "Not visible");
});

test("cloud cover caps every target regardless of how dark the site is", () => {
  const overcast = h.targetVerdicts(f.night(f.NEW_MOON_NIGHT, f.OVERCAST), 21.9);
  assert.ok(
    overcast.every((t) => t.verdict === "Not visible"),
    "nothing is visible through solid cloud, however dark the site"
  );
});

test("missing light pollution data yields Unknown, not a guess", () => {
  const unknown = h.targetVerdicts(f.night(f.NEW_MOON_NIGHT, f.CLEAR), null);
  assert.ok(unknown.every((t) => t.verdict === "Unknown"));
});

test("aurora verdict combines probability, cloud, and sky brightness", () => {
  const clear = f.night(f.NEW_MOON_NIGHT, f.CLEAR);
  const overcast = f.night(f.NEW_MOON_NIGHT, f.OVERCAST);

  assert.equal(h.auroraVerdict(f.aurora(60), clear, 21.9).verdict, "Likely");
  assert.equal(h.auroraVerdict(f.aurora(15), clear, 21.9).verdict, "Possible");
  assert.equal(h.auroraVerdict(f.aurora(0), clear, 21.9).verdict, "Not visible");
  assert.equal(h.auroraVerdict(f.aurora(60), overcast, 21.9).verdict, "Not visible");

  // Aurora is faint and diffuse, so a bright sky demotes it even at high
  // probability — the same way it demotes the Milky Way.
  assert.equal(h.auroraVerdict(f.aurora(60), clear, 18.0).verdict, "Possible");
  assert.equal(h.auroraVerdict(null, clear, 21.9).verdict, "Unknown");
});

// --- Star estimate -------------------------------------------------------------

test("star estimate reflects tonight, not just the site's baseline", () => {
  const site = f.SITES.cherrySprings;
  const fullMoon = report(f.night(f.FULL_MOON_NIGHT, f.CLEAR), site.sqm, site);

  assert.ok(fullMoon.stars, "star estimate is present");
  assert.ok(
    fullMoon.stars.visibleTonight < fullMoon.stars.visibleAtBest / 2,
    `moonlight should remove most of them: ${fullMoon.stars.visibleTonight} ` +
      `tonight vs ${fullMoon.stars.visibleAtBest} at best`
  );
});

test("star counts are consistent with the score's direction", () => {
  const dark = report(
    f.night(f.NEW_MOON_NIGHT, f.CLEAR),
    f.SITES.cherrySprings.sqm,
    f.SITES.cherrySprings
  );
  const city = report(
    f.night(f.NEW_MOON_NIGHT, f.CLEAR),
    f.SITES.chicago.sqm,
    f.SITES.chicago
  );

  assert.ok(dark.stars.visibleTonight > city.stars.visibleTonight * 10, "orders apart");
  assert.ok(city.stars.visibleTonight > 0, "even a city shows some stars");
});

// --- Degradation ---------------------------------------------------------------

test("the report survives every source being missing", () => {
  const r = h.buildReport(null, null, null, null, null);
  assert.equal(r.score, null);
  assert.equal(r.potentialScore, null);
  assert.equal(r.bestWindow, null);
  assert.ok(r.headline.length > 0, "still says something useful");
  assert.ok(r.targets.length > 0, "still lists targets, marked Unknown");
});

test("the report survives light pollution alone being missing", () => {
  const r = report(f.night(f.NEW_MOON_NIGHT, f.CLEAR), null, f.SITES.chicago);
  assert.equal(r.score, null, "cannot score without darkness");
  assert.equal(r.potentialScore, null);
  assert.ok(r.headline.length > 0);
});

test("the report survives clouds alone being missing", () => {
  const timeline = h.buildNightTimeline(null, f.lightPollution(21.9), 41.66, -77.81);
  const r = h.buildReport(null, f.lightPollution(21.9), null, null, timeline);

  assert.equal(r.score, null, "cannot score tonight without weather");
  assert.ok(r.potentialScore > 90, "but the site's potential is still knowable");
});

test("headline always returns a non-empty string", () => {
  // Fuzz across the whole score range so no band can fall through and produce
  // undefined in the UI.
  for (let score = 0; score <= 100; score += 5) {
    for (const penalty of [0, 0.5, 1.5, 3]) {
      const line = h.buildHeadline(score, f.night(f.NEW_MOON_NIGHT, f.CLEAR), 20, penalty);
      assert.ok(typeof line === "string" && line.length > 10, `score ${score}`);
    }
  }
  assert.ok(h.buildHeadline(null, null, null, 0).length > 0);
});
