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
    showAuroraForCoords(coords.lat, coords.lon, `(${coords.lat}, ${coords.lon})`);
  } else {
    // Otherwise treat it as a place name.
    searchByName(text);
  }
}

// --- 3. The shared final step: given coordinates, fetch + show aurora. ---
async function showAuroraForCoords(lat, lon, label) {
  setStatus(`Checking the sky for ${label}...`);
  resultsEl.hidden = true;

  try {
    // Call OUR backend route. fetch() works in the browser just like on
    // the server. The response is JSON, so we await response.json().
    const response = await fetch(`/api/aurora?lat=${lat}&lon=${lon}`);
    const data = await response.json();

    if (!response.ok) {
      // Our route sends { error: ... } with a non-200 status on failure.
      throw new Error(data.error || "Something went wrong");
    }

    // Build the results box. Using template literals (backticks) to insert
    // values into the HTML string.
    const p = data.auroraProbability;
    resultsEl.innerHTML = `
      <h2>${label}</h2>
      <p class="verdict">Aurora tonight: <strong>${verdict(p)}</strong></p>
      <p class="detail">Probability: ${p}%</p>
      <p class="detail">Coordinates: ${data.location.lat}, ${data.location.lon}</p>
      <p class="detail muted">Data observed ${new Date(
        data.observationTime
      ).toLocaleString()}</p>
    `;
    resultsEl.hidden = false;
    setStatus("");
  } catch (err) {
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
    showAuroraForCoords(place.lat, place.lon, label);
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
      showAuroraForCoords(
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
  showAuroraForCoords(place.lat, place.lon, label);
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
