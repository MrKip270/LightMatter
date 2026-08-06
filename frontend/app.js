// LightMatter frontend logic
//
// The flow (matches our backend architecture):
//   city name  -> /api/geocode -> { lat, lon }
//   "use my location" -> browser GPS -> { lat, lon }
//   { lat, lon } -> /api/aurora -> show result
//
// Both input methods produce coordinates, then take the SAME final path.

// --- 1. Grab the page elements we need to read from or write to. ---
const form = document.getElementById("location-form");
const placeInput = document.getElementById("place-input");
const locateBtn = document.getElementById("locate-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const suggestionsEl = document.getElementById("suggestions");

// --- 2. Small helpers ---

// Show a short status message (e.g. "Loading...", or an error).
function setStatus(message) {
  statusEl.textContent = message;
}

// Turn an aurora percentage into a plain-language verdict (PRD output model).
function verdict(probability) {
  if (probability >= 30) return "Likely";
  if (probability >= 10) return "Possible";
  if (probability > 0) return "Unlikely";
  return "None expected";
}

// Try to read "(lat, lon)" coordinates out of the text.
// Returns { lat, lon } if the input contains valid parentheses coordinates,
// or null if it doesn't (meaning we should treat it as a city name instead).
function parseCoordinates(text) {
  // Regex breakdown:
  //   \(              a literal "("
  //   \s*             optional spaces
  //   (-?\d+(?:\.\d+)?)  a number: optional "-", digits, optional ".decimals"
  //   \s*,\s*         a comma with optional spaces around it
  //   (-?\d+(?:\.\d+)?)  the second number
  //   \)              a literal ")"
  const match = text.match(
    /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/
  );
  if (!match) return null;

  // match[1] and match[2] are the two captured numbers (as strings).
  const lat = Number(match[1]);
  const lon = Number(match[2]);

  // Reject impossible coordinates.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon };
}

// Decide what the user meant: coordinates or a city name.
function handleSearch(text) {
  const coords = parseCoordinates(text);
  if (coords) {
    // Coordinates given directly — skip geocoding entirely.
    showSkyReportForCoords(coords.lat, coords.lon, `(${coords.lat}, ${coords.lon})`);
  } else {
    // Otherwise treat it as a place name.
    searchByName(text);
  }
}

// --- 3. The shared final step: given coordinates, fetch + show every source. ---

// Escape text before putting it in HTML. Place names come from an external API
// and from what the user typed, so treating them as trusted markup would be an
// injection hole. Setting .textContent on a throwaway element makes the browser
// do the escaping for us, correctly, instead of us hand-rolling replacements.
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

// "2026-07-31T20:00" -> "8 PM"
// Note we slice the string rather than build a Date, for exactly the reason the
// backend does: these timestamps are LOCAL TO THE SEARCHED LOCATION. Handing
// one to new Date() makes the browser reinterpret it in the *viewer's* timezone,
// so a Chicago sunset would display shifted for a user sitting in London.
function formatHour(localIso) {
  const hour = Number(localIso.slice(11, 13));
  const suffix = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12} ${suffix}`;
}

// Fetch JSON from one of our routes, throwing a useful Error on failure.
// Our routes reply with { error: "..." } and a non-200 status when they fail.
async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

// The backend now returns each source either as its normal object or as
// { error: "..." }. Normalise that into the { status, value/reason } shape the
// render functions below already expect, so they didn't have to change when we
// moved from three fetches to one.
function asSettled(source) {
  if (!source || source.error) {
    return { status: "rejected", reason: { message: source?.error || "No data" } };
  }
  return { status: "fulfilled", value: source };
}

// A consistent "this source didn't work" block, so every section degrades the
// same way. The PRD requires one dead source not to break the page.
function unavailableCard(title, reason) {
  return `
    <div class="card unavailable">
      <h3>${escapeHtml(title)}</h3>
      <p class="detail muted">${escapeHtml(reason)}</p>
    </div>
  `;
}

// Render the cloud section from an allSettled result.
function renderClouds(settled) {
  if (settled.status === "rejected") {
    return unavailableCard("Clouds", `Unavailable — ${settled.reason.message}`);
  }

  const data = settled.value;

  // The backend distinguishes "the request failed" (a 502, handled above) from
  // "the request worked but there's nothing to report" (this branch).
  if (!data.dataAvailable) {
    return unavailableCard("Clouds", data.visibility);
  }

  const run = data.bestClearRun;
  const clearWindowLine = run
    ? `<p class="detail">Clearest stretch: ${run.hours} hr from ${formatHour(
        run.start
      )} to ${formatHour(run.end)}</p>`
    : `<p class="detail">No clear stretch tonight.</p>`;

  const nightLine = data.night.polarEdgeCase
    ? `<p class="detail muted">The sun doesn't fully rise or set here today, so this covers the whole day.</p>`
    : `<p class="detail muted">Night window: ${formatHour(
        data.night.start
      )} to ${formatHour(data.night.end)} local time.</p>`;

  return `
    <div class="card">
      <h3>Clouds</h3>
      <p class="verdict"><strong>${escapeHtml(data.verdict)}</strong> — ${escapeHtml(
    data.visibility
  )}</p>
      <p class="detail">Average cover tonight: ${data.averageCloudCover}%</p>
      ${clearWindowLine}
      ${nightLine}
    </div>
  `;
}

// Render the light pollution section from an allSettled result.
function renderLightPollution(settled) {
  if (settled.status === "rejected") {
    return unavailableCard("Light pollution", `Unavailable — ${settled.reason.message}`);
  }

  const data = settled.value;

  if (!data.dataAvailable) {
    return unavailableCard("Light pollution", data.visibility);
  }

  return `
    <div class="card">
      <h3>Light pollution</h3>
      <p class="verdict"><strong>${escapeHtml(data.sky)}</strong></p>
      <p class="detail">${escapeHtml(data.visibility)}</p>
      <p class="detail">Sky brightness: ${data.sqm} mag/arcsec² —
        stars visible to magnitude ${data.nakedEyeLimitingMagnitude}</p>
      <p class="detail muted">${data.dataYear} data, ~${data.resolutionKm} km resolution.
        ${escapeHtml(data.attribution)}</p>
    </div>
  `;
}

// Render the moon section from an allSettled result.
function renderMoon(settled) {
  if (settled.status === "rejected") {
    return unavailableCard("Moon", `Unavailable — ${settled.reason.message}`);
  }

  const data = settled.value;

  const shortDate = (iso) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // An eclipse is worth surfacing loudly — they're rare and dateable.
  const eclipse = data.upcomingEclipse
    ? `<p class="detail eclipse">${
        data.upcomingEclipse.visibleHere ? "Visible here" : "Not visible from here"
      }: ${escapeHtml(data.upcomingEclipse.type)} lunar eclipse in
       ${data.upcomingEclipse.daysAway} days (${shortDate(
        data.upcomingEclipse.greatestEclipseUtc
      )}). ${escapeHtml(data.upcomingEclipse.note)}</p>`
    : "";

  return `
    <div class="card">
      <h3>Moon</h3>
      <p class="verdict"><strong>${escapeHtml(data.phaseName)}</strong> —
        ${data.illuminatedFraction}% lit</p>
      <p class="detail">Brightness vs a full moon: ${data.brightnessVsFullMoon}%
        <span class="muted">(moonlight falls off far faster than the lit area suggests)</span></p>
      <p class="detail">Currently ${
        data.aboveHorizonNow
          ? `${data.altitudeNow}° above the horizon`
          : "below the horizon"
      }</p>
      <p class="detail muted">Next new moon ${shortDate(data.nextNewMoon)} ·
        next full moon ${shortDate(data.nextFullMoon)}</p>
      ${eclipse}
    </div>
  `;
}

// Render the aurora section from an allSettled result.
function renderAurora(settled) {
  if (settled.status === "rejected") {
    return unavailableCard("Aurora", `Unavailable — ${settled.reason.message}`);
  }

  const data = settled.value;
  const probability = data.auroraProbability;

  return `
    <div class="card">
      <h3>Aurora</h3>
      <p class="verdict"><strong>${verdict(probability)}</strong></p>
      <p class="detail">Probability: ${probability}%</p>
      <p class="detail muted">Observed ${new Date(
        data.observationTime
      ).toLocaleString()}</p>
    </div>
  `;
}

// Map a verdict to a CSS class, so the four levels are visually distinct
// without relying on colour alone (the word is always there too).
function verdictClass(verdict) {
  return `verdict-${verdict.toLowerCase().replace(/\s+/g, "-")}`;
}

// The combined report: score, headline, and the per-target ladder.
function renderSummary(data) {
  // Two scores answer two different questions, so they get equal visual weight
  // and explicit labels. "Tonight" is actionable — go out or don't. "At its
  // best" is a stable property of the place — worth a trip or not. Without the
  // labels a reader would assume the bigger number is just a better version of
  // the smaller one.
  const band = (score) =>
    score >= 70 ? "good" : score >= 45 ? "fair" : score >= 20 ? "poor" : "bad";

  const scoreBox = (value, label, sublabel) =>
    value === null
      ? `<div class="score-box">
           <div class="score score-unknown">--</div>
           <div class="score-label">${escapeHtml(label)}</div>
           <div class="score-sub muted">no data</div>
         </div>`
      : `<div class="score-box">
           <div class="score" data-band="${band(value)}">${value}<span class="score-max">/100</span></div>
           <div class="score-label">${escapeHtml(label)}</div>
           <div class="score-sub muted">${escapeHtml(sublabel || "")}</div>
         </div>`;

  // Only worth saying when the gap is real — on a clear new-moon night the two
  // scores are nearly equal and the comparison is noise.
  const gap =
    data.score !== null && data.potentialScore !== null
      ? data.potentialScore - data.score
      : null;
  const gapNote =
    gap !== null && gap >= 15
      ? `Tonight is well below what this location can do — conditions, not the site, are the limit.`
      : gap !== null && gap < 8 && data.potentialScore >= 45
        ? `Tonight is close to the best this location offers.`
        : "";

  const scoreBlock = `
    <div class="scores">
      ${scoreBox(data.score, "Tonight", "clouds + moon + light")}
      ${scoreBox(data.potentialScore, "At its best", data.potentialLabel)}
    </div>
    ${gapNote ? `<p class="detail muted gap-note">${escapeHtml(gapNote)}</p>` : ""}
  `;

  // The single most actionable line in the whole report: when to go outside.
  const window = data.bestWindow
    ? `<p class="window"><strong>Best window:</strong> ${formatHour(
        data.bestWindow.start
      )} to ${formatHour(data.bestWindow.end)} (${data.bestWindow.hours} hr)${
        data.bestWindow.moonFree ? "" : " — moonlit"
      }</p>`
    : `<p class="window muted">No usable window tonight.</p>`;

  // The most concrete line in the report. "About 66 stars" means something to
  // anyone; "17.15 mag/arcsec²" means something to almost no one.
  let starsLine = "";
  if (data.stars) {
    const s = data.stars;
    const lost =
      s.visibleAtBest && s.visibleAtBest > s.visibleTonight
        ? Math.round(100 * (1 - s.visibleTonight / s.visibleAtBest))
        : 0;

    // Star counts grow geometrically with limiting magnitude, so even a modest
    // brightening removes a startling share of them. Worth stating outright.
    const lostNote =
      lost >= 15
        ? ` — about ${lost}% fewer than this site's best of ${s.visibleAtBest.toLocaleString()}`
        : "";

    starsLine = `
      <p class="stars">
        <strong>~${s.visibleTonight.toLocaleString()} stars</strong> visible tonight,
        down to magnitude ${s.limitingMagnitude}${lostNote}.
      </p>
      <p class="detail muted">For scale, a perfectly dark sky anywhere on Earth
        shows about ${s.visibleUnderPristineSky.toLocaleString()}.</p>
    `;
  }

  // Only mention the moon penalty when it's actually doing damage. Showing
  // "0.01 magnitudes" would be noise.
  const moonLine =
    data.sky.moonPenaltyMagnitudes >= 0.3
      ? `<p class="detail muted">Moonlight is costing
         ${data.sky.moonPenaltyMagnitudes} magnitudes — this site reads
         ${data.sky.baselineSqm} without the Moon, ${data.sky.effectiveSqm} tonight.</p>`
      : "";

  const targets = data.targets
    .map(
      (target) => `
        <li class="${verdictClass(target.verdict)}">
          <span class="target-verdict">${escapeHtml(target.verdict)}</span>
          <span class="target-name">${escapeHtml(target.name)}</span>
          <span class="target-reason">${escapeHtml(target.reason)}</span>
        </li>`
    )
    .join("");

  return `
    <div class="summary">
      ${scoreBlock}
      <p class="headline">${escapeHtml(data.headline)}</p>
      ${window}
      ${starsLine}
      ${moonLine}
      <ul class="targets">${targets}</ul>
    </div>
  `;
}

// One request, one answer. The backend fans out to every source in parallel and
// does the combining, which is why this is a single fetch rather than three:
// the fan-out moved server-side where it belongs, and the browser no longer
// needs to know how many sources exist. Adding a fifth source later changes
// nothing here.
async function showSkyReportForCoords(lat, lon, label) {
  setStatus(`Checking the sky for ${label}...`);
  resultsEl.hidden = true;

  try {
    const data = await fetchJson(`/api/sky?lat=${lat}&lon=${lon}`);

    // Order matters for reading, not for fetching. Clouds first because they
    // can veto the whole night, then light pollution (a fixed property of the
    // place), then aurora (the thing you might travel for).
    resultsEl.innerHTML = `
      <h2>${escapeHtml(label)}</h2>
      ${renderSummary(data)}
      <h4 class="detail-heading">Where that came from</h4>
      ${renderClouds(asSettled(data.sources.clouds))}
      ${renderMoon(asSettled(data.sources.moon))}
      ${renderLightPollution(asSettled(data.sources.lightPollution))}
      ${renderAurora(asSettled(data.sources.aurora))}
    `;
    resultsEl.hidden = false;
    setStatus("");
  } catch (err) {
    // Only reached if /api/sky itself fails. Individual source failures come
    // back inside a successful response and degrade card by card.
    setStatus(`Could not get sky data: ${err.message}`);
  }
}

// --- 4. Path A: user typed a city name. ---
async function searchByName(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    setStatus("Type a city name first.");
    return;
  }

  setStatus(`Looking up "${trimmed}"...`);

  try {
    // encodeURIComponent keeps spaces/accents from breaking the URL.
    const response = await fetch(
      `/api/geocode?q=${encodeURIComponent(trimmed)}`
    );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Geocoding failed");
    }
    if (data.results.length === 0) {
      setStatus(`No place found for "${trimmed}".`);
      return;
    }

    // Take the best (first) match and hand its coordinates to the shared step.
    const place = data.results[0];
    const label = [place.name, place.region, place.country]
      .filter(Boolean) // drop any undefined pieces
      .join(", ");
    showSkyReportForCoords(place.lat, place.lon, label);
  } catch (err) {
    setStatus(`Lookup failed: ${err.message}`);
  }
}

// --- 5. Path B: user clicked "Use my location" (a location ping). ---
function useMyLocation() {
  // navigator.geolocation is the browser's built-in GPS access.
  if (!navigator.geolocation) {
    setStatus("Your browser doesn't support location access.");
    return;
  }

  setStatus("Requesting your location...");

  navigator.geolocation.getCurrentPosition(
    // Success: we get the user's coordinates.
    (position) => {
      const { latitude, longitude } = position.coords;
      showSkyReportForCoords(
        latitude.toFixed(4),
        longitude.toFixed(4),
        "your location"
      );
    },
    // Failure: they denied permission or it timed out.
    () => {
      setStatus("Couldn't get your location (permission denied?).");
    }
  );
}

// --- 5b. Autocomplete: suggest real cities as the user types. ---

// "Debounce" delays a function until the user stops typing for `delayMs`.
// Without it, we'd fire a geocode request on EVERY keystroke. With it, we
// wait for a short pause, then send a single request.
function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

// Hide and empty the dropdown.
function hideSuggestions() {
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
}

// When a suggestion is chosen: fill the box, close the list, fetch aurora.
function selectPlace(place, label) {
  placeInput.value = label;
  hideSuggestions();
  showSkyReportForCoords(place.lat, place.lon, label);
}

// Build the dropdown <li> items from a list of places.
function renderSuggestions(results) {
  if (!results || results.length === 0) {
    hideSuggestions();
    return;
  }

  suggestionsEl.innerHTML = ""; // clear old items

  results.forEach((place) => {
    const label = [place.name, place.region, place.country]
      .filter(Boolean)
      .join(", ");

    // createElement builds a real DOM node we can attach behavior to.
    const li = document.createElement("li");
    li.textContent = label;
    li.addEventListener("click", () => selectPlace(place, label));
    suggestionsEl.appendChild(li);
  });

  suggestionsEl.hidden = false;
}

// Ask the backend for matches, then show them.
async function fetchSuggestions(query) {
  try {
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) return; // ignore errors here; the Search button still works

    // Stale-response guard: if the user kept typing, the box no longer matches
    // this (older) request, so ignore it. Prevents a slow, earlier response
    // from overwriting newer suggestions.
    if (data.query !== placeInput.value.trim()) return;

    renderSuggestions(data.results);
  } catch {
    // Suggestions are a convenience; if they fail, stay silent.
  }
}

// --- 6. Wire up the events. ---

// Submitting the form (Search button OR pressing Enter).
form.addEventListener("submit", (event) => {
  event.preventDefault(); // stop the browser from reloading the page
  hideSuggestions();
  handleSearch(placeInput.value);
});

// Clicking "Use my location".
locateBtn.addEventListener("click", useMyLocation);

// As the user types, fetch suggestions — debounced so we don't spam the
// server. Skip it when the box is empty or already holds coordinates.
placeInput.addEventListener(
  "input",
  debounce(() => {
    const text = placeInput.value.trim();
    if (!text || parseCoordinates(text)) {
      hideSuggestions();
      return;
    }
    fetchSuggestions(text);
  }, 250)
);

// Close the dropdown on Escape, or when clicking outside the input area.
placeInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideSuggestions();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".input-wrap")) hideSuggestions();
});
