// Tests for the moon source.
//
// The moonlight model is the most physics-heavy code in the project, so these
// tests do two things: check it against published astronomical values, and lock
// in a regression for a real bug that shipped.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getMoon, effectiveSqm, relativeBrightness, helpers: h } =
  require("../backend/sources/moon");

// Assert a value is within tolerance — the right way to test physics, where
// exact equality would be meaningless.
function close(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} ± ${tolerance}, got ${actual}`
  );
}

test("moon brightness matches published values, not illuminated fraction", () => {
  // The key non-obvious fact in the whole model. A quarter moon LOOKS half lit
  // but delivers about 9% of a full moon's light, because of shadowing and
  // backscatter on the lunar surface. Using the illuminated fraction directly
  // would overstate quarter-moon washout roughly fivefold.
  close(relativeBrightness(0.5), 1.0, 0.001, "full moon is the reference");
  close(relativeBrightness(0.25), 0.09, 0.02, "quarter moon ~9%, NOT 50%");
  close(relativeBrightness(0.375), 0.34, 0.05, "gibbous");
  assert.ok(relativeBrightness(0.0) < 0.001, "new moon is effectively dark");
});

test("relativeBrightness is symmetric about full moon", () => {
  // Waxing and waning phases at equal angles are equally bright.
  close(relativeBrightness(0.4), relativeBrightness(0.6), 0.0001, "symmetry");
  close(relativeBrightness(0.1), relativeBrightness(0.9), 0.0001, "symmetry");
});

test("a moon below the horizon costs nothing at all", () => {
  // Altitude matters as much as phase. This is the case a phase-only model
  // (e.g. a daily moon_phase API) gets wrong.
  assert.equal(effectiveSqm(21.93, 0.5, -1), 21.93, "just below horizon");
  assert.equal(effectiveSqm(21.93, 0.5, -40), 21.93, "far below horizon");
  assert.equal(effectiveSqm(21.93, 0.5, 0), 21.93, "exactly on the horizon");
});

test("full moon washout matches published magnitudes", () => {
  // A full moon costs a dark site roughly 3 magnitudes. That is the headline
  // number this model has to reproduce.
  const dark = effectiveSqm(21.93, 0.5, 90);
  close(21.93 - dark, 3.5, 0.5, "full moon at zenith over a pristine site");
});

test("moonlight punishes dark sites and barely touches cities", () => {
  // The counterintuitive result, and the reason the moon had to be folded into
  // effective SQM rather than applied as a flat penalty. A city sky is already
  // brighter than the Moon can make it.
  const darkPenalty = 21.93 - effectiveSqm(21.93, 0.5, 90);
  const cityPenalty = 17.15 - effectiveSqm(17.15, 0.5, 90);

  assert.ok(darkPenalty > 3, `dark site loses a lot (${darkPenalty.toFixed(2)})`);
  assert.ok(cityPenalty < 0.5, `city barely notices (${cityPenalty.toFixed(2)})`);
  assert.ok(darkPenalty > cityPenalty * 5, "an order-of-magnitude difference");
});

test("moon washout increases with altitude", () => {
  // Monotonicity: a property that must hold for every input, not just the ones
  // we happened to pick.
  let previous = Infinity;
  for (const altitude of [10, 20, 40, 60, 90]) {
    const sqm = effectiveSqm(21.93, 0.5, altitude);
    assert.ok(sqm < previous, `higher moon = brighter sky (at ${altitude}°)`);
    previous = sqm;
  }
});

test("effectiveSqm never brightens the sky", () => {
  // Adding a light source can only make the sky brighter (lower SQM), never
  // darker. A sign error in the linear-flux maths would break this.
  for (const phase of [0, 0.25, 0.5, 0.75]) {
    for (const altitude of [-10, 0, 30, 90]) {
      assert.ok(
        effectiveSqm(21.0, phase, altitude) <= 21.0 + 1e-9,
        `phase ${phase}, altitude ${altitude}`
      );
    }
  }
});

test("phase names cover the full cycle without gaps", () => {
  const seen = new Set();
  for (let phase = 0; phase < 1; phase += 0.01) {
    const name = h.phaseName(phase);
    assert.ok(typeof name === "string" && name.length > 0, `phase ${phase}`);
    seen.add(name);
  }
  assert.equal(seen.size, 8, "all eight named phases are reachable");
  assert.equal(h.phaseName(0), "New Moon");
  assert.equal(h.phaseName(0.5), "Full Moon");
});

test("REGRESSION: nextPhaseAfter must never return a time in the past", () => {
  // The bug: the original implementation scanned forward and stopped when the
  // distance to the target started growing. When the phase is ALREADY moving
  // away from the target, the distance grows from the very first step — so it
  // stopped immediately and returned a "next full moon" that had already
  // happened. Caught only by printing real values.
  //
  // Checked across a full lunar cycle so no starting phase can reproduce it.
  for (let day = 0; day < 30; day++) {
    const from = new Date(Date.UTC(2026, 7, 1) + day * 86400000);
    for (const target of [0, 0.5]) {
      const next = h.nextPhaseAfter(from, target);
      assert.ok(next !== null, `day ${day}, target ${target}: got a result`);
      assert.ok(
        next.getTime() > from.getTime(),
        `day ${day}, target ${target}: ${next.toISOString()} must be after ${from.toISOString()}`
      );
      assert.ok(
        next.getTime() - from.getTime() < 31 * 86400000,
        `day ${day}, target ${target}: within one lunar cycle`
      );
    }
  }
});

test("REGRESSION: asked at the exact moment of a phase, return the NEXT one", () => {
  // The hard case, and the one the broad sweep above misses. When the current
  // phase already equals the target, "next" is ambiguous — a naive
  // implementation returns right now, so the UI shows "next full moon: today"
  // forever while the moon visibly wanes.
  //
  // A mutation test proved the sweep alone did not catch this: disabling the
  // guard left the suite green, because no day in the sweep happened to land
  // exactly on a phase boundary.
  const exactFullMoon = new Date("2026-08-28T04:12:54Z");
  const next = h.nextPhaseAfter(exactFullMoon, 0.5);

  const daysAway = (next.getTime() - exactFullMoon.getTime()) / 86400000;
  assert.ok(
    daysAway > 25 && daysAway < 32,
    `must skip to the following cycle, got ${daysAway.toFixed(1)} days away`
  );

  const exactNewMoon = h.nextPhaseAfter(new Date("2026-08-01T00:00:00Z"), 0);
  const afterThat = h.nextPhaseAfter(exactNewMoon, 0);
  const gap = (afterThat.getTime() - exactNewMoon.getTime()) / 86400000;
  assert.ok(gap > 25 && gap < 32, `consecutive new moons ~29.5 days apart, got ${gap.toFixed(1)}`);
});

test("consecutive phases are separated by one synodic month", () => {
  // A property check across two full years and BOTH targets: no matter where
  // you start, the gap between one occurrence and the next must be a lunar
  // cycle. Catches "returned the current one" and "skipped a cycle" alike.
  //
  // Originally this only checked full moons over 12 months, and passed while
  // new moon was still broken in six of twenty-four cases. The lesson: a
  // property test is only as good as the domain it sweeps. Widening the sweep
  // was what exposed it.
  for (let month = 0; month < 24; month++) {
    for (const [name, target] of [["new", 0], ["full", 0.5]]) {
      const from = new Date(Date.UTC(2026, month, 5));

      const first = h.nextPhaseAfter(from, target);
      assert.ok(first, `month ${month}, ${name}: got a first result`);

      const second = h.nextPhaseAfter(first, target);
      assert.ok(second, `month ${month}, ${name}: got a second result`);

      const gap = (second.getTime() - first.getTime()) / 86400000;
      assert.ok(
        gap > 28.5 && gap < 30.5,
        `month ${month}, consecutive ${name} moons ${gap.toFixed(2)} days apart ` +
          `(${first.toISOString()} -> ${second.toISOString()})`
      );
    }
  }
});

test("nextPhaseAfter satisfies all three invariants across a decade", () => {
  // The broadest sweep, checking every property at once rather than one per
  // test. Starting dates are deliberately scattered across the month so the
  // sweep does not accidentally sample only mid-cycle instants — which is
  // exactly how the earlier version stayed green while new moon was broken.
  const suncalc = require("suncalc");

  for (let month = 0; month < 120; month++) {
    const dayOfMonth = 3 + ((month * 7) % 25); // wanders through the cycle
    const from = new Date(Date.UTC(2026, month, dayOfMonth));

    for (const [name, target] of [["new", 0], ["full", 0.5]]) {
      const next = h.nextPhaseAfter(from, target);
      const label = `month ${month}, ${name} moon`;

      // 1. Always returns something.
      assert.ok(next, `${label}: not null`);

      // 2. Strictly in the future, and within one cycle — never skipping ahead.
      const daysAhead = (next.getTime() - from.getTime()) / 86400000;
      assert.ok(
        daysAhead > 0 && daysAhead <= 30.5,
        `${label}: ${daysAhead.toFixed(2)} days ahead`
      );

      // 3. The moon really is at that phase when it says it is. Without this,
      //    a function returning "29.5 days from now" unconditionally would
      //    satisfy the first two and still be nonsense.
      const phase = suncalc.getMoonIllumination(next).phase;
      const distance = Math.min(Math.abs(phase - target), 1 - Math.abs(phase - target));
      assert.ok(distance < 0.02, `${label}: phase there is ${phase.toFixed(4)}, wanted ${target}`);
    }
  }
});

test("computed full moon matches NASA's eclipse time independently", () => {
  // The strongest validation available. A lunar eclipse can ONLY occur at full
  // moon, so NASA's greatest-eclipse time for 2026-08-28 is an independent
  // measurement of that full moon. Our suncalc-based computation and NASA's
  // canon are entirely separate methods; agreement to the minute means the
  // phase maths is right.
  const nasaGreatestEclipse = new Date("2026-08-28T04:12:00Z");
  const ourFullMoon = h.nextPhaseAfter(new Date("2026-08-05T06:00:00Z"), 0.5);

  const differenceMinutes =
    Math.abs(ourFullMoon.getTime() - nasaGreatestEclipse.getTime()) / 60000;

  assert.ok(
    differenceMinutes < 5,
    `full moon ${ourFullMoon.toISOString()} vs NASA ${nasaGreatestEclipse.toISOString()} ` +
      `— ${differenceMinutes.toFixed(1)} minutes apart`
  );
});

test("getMoon reports the expected phase on known dates", () => {
  const full = getMoon(41.66, -77.81, new Date("2026-08-28T04:12:00Z"));
  assert.equal(full.phaseName, "Full Moon");
  assert.ok(full.illuminatedFraction > 99, "essentially fully lit");

  const dark = getMoon(41.66, -77.81, new Date("2026-08-12T18:00:00Z"));
  assert.equal(dark.phaseName, "New Moon");
  assert.ok(dark.illuminatedFraction < 2, "essentially unlit");
});

test("brightnessVsFullMoon is far below illuminatedFraction except near full", () => {
  const quarter = getMoon(41.66, -77.81, new Date("2026-08-20T00:00:00Z"));
  assert.ok(
    quarter.brightnessVsFullMoon < quarter.illuminatedFraction / 2,
    `at ~half lit (${quarter.illuminatedFraction}%), brightness is only ` +
      `${quarter.brightnessVsFullMoon}% of full`
  );
});

test("lunar eclipse is found and its visibility depends on location", () => {
  const before = new Date("2026-08-05T00:00:00Z");

  // The Americas: eclipse happens near local midnight, moon well up.
  const americas = h.findEclipse(41.66, -77.81, before);
  assert.ok(americas, "the 2026-08-28 eclipse is within 60 days");
  assert.equal(americas.type, "partial");
  assert.equal(americas.visibleHere, true, "visible from Pennsylvania");
  assert.ok(americas.moonAltitude > 0);

  // A lunar eclipse is visible from the whole night side, so somewhere in
  // daylight at that instant must NOT see it. If this ever passes everywhere,
  // the altitude check has stopped working.
  const elsewhere = h.findEclipse(35.68, 139.69, before); // Tokyo
  assert.equal(elsewhere.visibleHere, false, "not visible from Tokyo (daytime)");
  assert.ok(elsewhere.moonAltitude < 0, "moon is below the horizon there");
});

test("no eclipse is reported when none falls in the window", () => {
  // Looking from a date well after the catalogued eclipses.
  assert.equal(h.findEclipse(41.66, -77.81, new Date("2030-01-01T00:00:00Z")), null);
});
