// LightMatter — reverse geocoding data source
//
// Coordinates -> a human-readable place name. The inverse of routes/geocode.js.
//
// WHY THIS MUST LIVE ON THE SERVER
// Nominatim's usage policy requires a User-Agent header that identifies the
// application. Browsers deliberately forbid JavaScript from setting User-Agent
// (it is a "forbidden header name" in the fetch spec), so a browser physically
// cannot make a policy-compliant request. This is an architectural requirement,
// not a preference.
//
// Two other candidate services were rejected:
//   - BigDataCloud's free tier looks ideal (no key, no rate limit) but its fair
//     use policy restricts it to the CURRENT coordinates of the client device,
//     obtained via the platform's location API. A map click is a third-party
//     coordinate, so using it here would breach the terms.
//   - Open-Meteo's geocoder, which we already use, is forward-only.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";

// Nominatim asks for a User-Agent naming the app, with a contact URL.
const USER_AGENT = "LightMatter/0.1 (https://github.com/MrKip270/LightMatter)";

// Nominatim's policy is an absolute maximum of 1 request per second. This is
// not a suggestion — exceeding it gets an IP banned. We enforce it here rather
// than trusting the frontend, because the frontend is not the only possible
// caller of our API.
const MIN_INTERVAL_MS = 1000;
let lastRequestAt = 0;

// Small in-memory cache. Reverse geocoding a coordinate is a pure lookup whose
// answer effectively never changes, and map users click around the same area
// repeatedly, so this removes most requests before the throttle ever sees them.
const cache = new Map();
const CACHE_LIMIT = 500;

// Round to ~100 m so near-identical clicks share a cache entry. Any finer and
// the cache would almost never hit; any coarser and distinct neighbourhoods
// would collide.
function cacheKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

// Build a readable label from Nominatim's address object, most specific first.
//
// Nominatim returns a `display_name` too, but it is often absurdly long
// ("Coudersport, Potter County, Pennsylvania, 16915, United States of
// America"). We assemble our own from the fields that matter.
function buildLabel(address = {}) {
  const locality =
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    address.suburb ||
    address.municipality ||
    address.county;

  const region = address.state || address.province || address.region;
  const country = address.country;

  const parts = [locality, region, country].filter(Boolean);

  // Water and wilderness legitimately have no locality — Nominatim returns an
  // error object for open ocean. Callers handle a null label by falling back to
  // raw coordinates.
  return parts.length > 0 ? parts.join(", ") : null;
}

async function reverseGeocode(lat, lon) {
  const key = cacheKey(lat, lon);
  if (cache.has(key)) {
    return { ...cache.get(key), cached: true };
  }

  // Respect the rate limit by waiting, not by failing. A caller would rather
  // wait 400 ms than get an error they can do nothing about.
  const waitMs = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestAt = Date.now();

  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "jsonv2",
    // zoom 10 is roughly city level. Higher values return individual buildings,
    // which is far more precision than "where am I looking at the sky from".
    zoom: "10",
    addressdetails: "1",
  });

  const response = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
  });

  if (!response.ok) {
    throw new Error(`Nominatim responded with status ${response.status}`);
  }

  const data = await response.json();

  // Nominatim signals "nothing here" with an { error } object and HTTP 200 —
  // open ocean, Antarctica, and other unnamed places. That is not a failure.
  const label = data.error ? null : buildLabel(data.address);

  const result = {
    source: "OpenStreetMap Nominatim",
    dataAvailable: label !== null,
    location: { lat, lon },
    label,
    attribution: "© OpenStreetMap contributors",
    cached: false,
  };

  // Naive LRU: drop the oldest entry once full. Map preserves insertion order,
  // so the first key is the oldest.
  if (cache.size >= CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, result);

  return result;
}

module.exports = {
  reverseGeocode,
  helpers: {
    buildLabel,
    cacheKey,
    MIN_INTERVAL_MS,
    USER_AGENT,
    cache,
    // Tests share this module, so the throttle clock persists between them and
    // every test after the first would sit out a full second. Exposing a reset
    // keeps the suite fast while still letting one test exercise the real
    // waiting behaviour. Named for its purpose so nobody calls it in anger.
    _resetThrottleForTests: () => {
      lastRequestAt = 0;
    },
  },
};
