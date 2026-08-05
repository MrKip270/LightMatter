// LightMatter — moon data source
//
// Computed locally with suncalc (Meeus' Astronomical Algorithms). No API, no
// key, no rate limit, and it works for ANY date — which is what the PRD's
// future-date feature will need. It also gives moon ALTITUDE hour by hour,
// which a daily-summary API cannot, and altitude turns out to matter as much as
// phase: a full moon below the horizon washes out nothing at all.
//
// This resolves the PRD's open "hosted astronomy API vs local ephemeris"
// question in favour of local computation.
//
// GOTCHA: suncalc 2.x returns angles in DEGREES. Version 1.x returned RADIANS,
// and most tutorials and StackOverflow answers still assume radians. Verified
// empirically: moon altitude over 24h ranges -30 to +65, which is degrees.

const suncalc = require("suncalc");
const eclipseData = require("../data/lunar-eclipses.json");

// Sky brightness produced by a full moon at the zenith, in SQM. Published
// values range roughly 17.8-19.5 depending on aerosols and airmass; 18.5 is a
// reasonable middle. This is the single tuning constant of the washout model.
const MOON_FULL_ZENITH_SQM = 18.5;

// A moon this faint is treated as "effectively moonless" when hunting for a
// dark window (0.5 magnitudes of skyglow is roughly imperceptible).
const MOONLESS_PENALTY_THRESHOLD = 0.5;

// --- Pure helpers -------------------------------------------------------------

// Brightness of the moon relative to full, from its phase.
//
// This is NOT the illuminated fraction. Moonlight falls off far faster than
// area suggests, because of shadowing and backscatter on the lunar surface: a
// quarter moon looks half-lit but delivers only about 9% of a full moon's light.
// Using `fraction` directly here would overstate quarter-moon washout ~5x.
//
// Standard lunar phase function: dmag = 0.026a + 4e-9 a^4, a = phase angle.
function relativeBrightness(phase) {
  const alpha = 360 * Math.abs(phase - 0.5); // 0 deg = full, 180 deg = new
  const deltaMag = 0.026 * alpha + 4e-9 * Math.pow(alpha, 4);
  return Math.pow(10, -0.4 * deltaMag);
}

// Sky brightness with moonlight added, in SQM.
//
// Brightness sources ADD IN LINEAR FLUX, not in magnitudes — the same principle
// that governed averaging the light pollution atlas. Convert both to linear,
// sum, convert back. Adding magnitudes directly would be meaningless.
function effectiveSqm(siteSqm, phase, altitudeDegrees) {
  if (siteSqm === null || siteSqm === undefined) return null;
  if (altitudeDegrees <= 0) return siteSqm; // below the horizon: no contribution

  // Higher moon = shorter path through the atmosphere = more scattered light
  // reaching you. sin(altitude) is the standard first-order approximation.
  const altitudeFactor = Math.sin((altitudeDegrees * Math.PI) / 180);

  const moonFlux =
    Math.pow(10, -0.4 * MOON_FULL_ZENITH_SQM) *
    relativeBrightness(phase) *
    altitudeFactor;
  const siteFlux = Math.pow(10, -0.4 * siteSqm);

  return -2.5 * Math.log10(siteFlux + moonFlux);
}

// suncalc's phase: 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last.
function phaseName(phase) {
  if (phase < 0.03 || phase > 0.97) return "New Moon";
  if (phase < 0.22) return "Waxing Crescent";
  if (phase < 0.28) return "First Quarter";
  if (phase < 0.47) return "Waxing Gibbous";
  if (phase < 0.53) return "Full Moon";
  if (phase < 0.72) return "Waning Gibbous";
  if (phase < 0.78) return "Last Quarter";
  return "Waning Crescent";
}

// Mean length of one lunar cycle, new moon to new moon.
const SYNODIC_MONTH_MS = 29.530588853 * 24 * 60 * 60 * 1000;

// Find the next time the moon reaches a target phase (0 = new, 0.5 = full).
//
// Estimate analytically, then refine. Phase advances roughly linearly from 0 to
// 1 over a synodic month, so the fraction of a cycle still to go gives a first
// guess within a few hours; ternary search then closes the gap to the minute.
//
// An earlier version scanned forward hour by hour and stopped when the distance
// to the target started growing. That was wrong: when the phase is ALREADY
// moving away from the target, the distance grows from the very first step, so
// it stopped immediately and returned a "next full moon" in the past. Local
// minimum detection needs the search to start on the correct side of the
// minimum, and here it usually doesn't.
function nextPhaseAfter(from, target) {
  // Circular distance: phase wraps at 1.0, so 0.99 and 0.01 are close.
  const distance = (time) => {
    const raw = Math.abs(suncalc.getMoonIllumination(time).phase - target);
    return Math.min(raw, 1 - raw);
  };

  const currentPhase = suncalc.getMoonIllumination(from).phase;

  // How much of a cycle remains until the target comes round again.
  let cyclesAhead = (target - currentPhase + 1) % 1;
  // If we are essentially on it right now, we want the NEXT one, not this one.
  if (cyclesAhead < 0.01) cyclesAhead += 1;

  const estimate = from.getTime() + cyclesAhead * SYNODIC_MONTH_MS;

  // Refine within a generous window — the moon's actual motion deviates from
  // the mean cycle by up to about half a day.
  const WINDOW_MS = 1.5 * 24 * 60 * 60 * 1000;
  let low = estimate - WINDOW_MS;
  let high = estimate + WINDOW_MS;

  for (let i = 0; i < 60; i++) {
    const third = (high - low) / 3;
    const a = new Date(low + third);
    const b = new Date(high - third);
    if (distance(a) < distance(b)) high = b.getTime();
    else low = a.getTime();
  }

  const result = new Date((low + high) / 2);
  return result.getTime() > from.getTime() ? result : null;
}

// A lunar eclipse is visible from anywhere on Earth's night side — unlike a
// solar eclipse, which needs a narrow ground track. So "can I see it?" reduces
// to "is the Moon above my horizon at greatest eclipse?", which suncalc answers
// exactly. That is why lunar eclipses are tractable here and solar ones are not.
function findEclipse(lat, lon, from, withinDays = 60) {
  const horizon = from.getTime() + withinDays * 24 * 60 * 60 * 1000;

  for (const eclipse of eclipseData.eclipses) {
    const when = new Date(eclipse.greatestEclipseUtc);
    if (when.getTime() < from.getTime() || when.getTime() > horizon) continue;

    const altitude = suncalc.getMoonPosition(when, lat, lon).altitude;

    return {
      ...eclipse,
      moonAltitude: Number(altitude.toFixed(1)),
      visibleHere: altitude > 0,
      daysAway: Math.round((when.getTime() - from.getTime()) / 86400000),
      note: eclipse.note,
    };
  }

  return null;
}

// --- The source --------------------------------------------------------------

// `at` is the moment to describe (defaults to now). `hours` is an optional list
// of UTC Date objects — normally the night window from the clouds source — to
// sample moon altitude across.
function getMoon(lat, lon, at = new Date(), hours = []) {
  const illumination = suncalc.getMoonIllumination(at);
  const position = suncalc.getMoonPosition(at, lat, lon);
  const times = suncalc.getMoonTimes(at, lat, lon, true);

  const samples = hours.map((time) => {
    const hourIllumination = suncalc.getMoonIllumination(time);
    const altitude = suncalc.getMoonPosition(time, lat, lon).altitude;
    return {
      time: time.toISOString(),
      altitude: Number(altitude.toFixed(1)),
      phase: hourIllumination.phase,
      // Penalty in magnitudes against a pristine 22.0 sky, so the frontend can
      // show "how much moonlight" without needing a site SQM.
      penaltyMagnitudes: Number(
        (22 - effectiveSqm(22, hourIllumination.phase, altitude)).toFixed(2)
      ),
      aboveHorizon: altitude > 0,
    };
  });

  return {
    source: "suncalc (Meeus astronomical algorithms)",
    dataAvailable: true,
    location: { lat, lon },
    phase: Number(illumination.phase.toFixed(4)),
    phaseName: phaseName(illumination.phase),
    illuminatedFraction: Number((illumination.fraction * 100).toFixed(1)),
    // The number that actually drives washout — see relativeBrightness above
    // for why this is far below illuminatedFraction except near full.
    brightnessVsFullMoon: Number((relativeBrightness(illumination.phase) * 100).toFixed(1)),
    altitudeNow: Number(position.altitude.toFixed(1)),
    aboveHorizonNow: position.altitude > 0,
    moonrise: times.rise ? times.rise.toISOString() : null,
    moonset: times.set ? times.set.toISOString() : null,
    alwaysUp: Boolean(times.alwaysUp),
    alwaysDown: Boolean(times.alwaysDown),
    nextNewMoon: nextPhaseAfter(at, 0)?.toISOString() ?? null,
    nextFullMoon: nextPhaseAfter(at, 0.5)?.toISOString() ?? null,
    upcomingEclipse: findEclipse(lat, lon, at),
    hourly: samples,
  };
}

module.exports = {
  getMoon,
  effectiveSqm,
  relativeBrightness,
  helpers: {
    phaseName,
    nextPhaseAfter,
    findEclipse,
    MOON_FULL_ZENITH_SQM,
    MOONLESS_PENALTY_THRESHOLD,
  },
};
