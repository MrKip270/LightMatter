/* PROTOTYPE — throwaway. See index.html for the question this answers.
 *
 * ORDER MATTERS HERE. The chrome renders BEFORE the map is touched, and map
 * setup is wrapped in try/catch. An earlier version called initMap() first, so
 * a single exception killed the script before any UI existed and left a blank
 * dark page. Layout work should never depend on the network succeeding.
 */

// Anything that throws becomes a visible banner rather than a silent blank page.
const crashEl = document.getElementById("crash");
function crash(where, err) {
  console.error(where, err);
  crashEl.hidden = false;
  crashEl.textContent = `${where}: ${err.message}`;
}
window.addEventListener("error", (e) => crash("Script error", e.error || e));

const ui = document.getElementById("ui");
const entry = document.getElementById("entry");

let map = null;
let marker = null;
let lightLayer = null;
let lightOn = true;
// Starts subtle. The slider lets anyone who wants the data louder turn it up,
// but the default should let the map read as a map.
let lightOpacity = 0.35;
let report = null; // last /api/sky result
let searchText = "";
let railOpen = false;
let infoOpen = false;

// --- small helpers ----------------------------------------------------------

const esc = (s) => {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
};

// Five steps, brightest to darkest: white → pink → orange → crimson → blood.
// Brightness carries the meaning, so the scale still reads for anyone who
// cannot separate the hues.
const band = (n) => {
  if (n === null || n === undefined) return "none";
  if (n >= 85) return "peak";
  if (n >= 70) return "good";
  if (n >= 45) return "fair";
  if (n >= 20) return "poor";
  return "bad";
};

const hour = (iso) => {
  if (!iso) return "—";
  const h = Number(iso.slice(11, 13));
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
};

async function getJson(url) {
  const r = await fetch(url);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

// --- rendering --------------------------------------------------------------

function render(state = {}) {
  const showInfo = infoOpen && (report || state.loading || state.error);

  ui.innerHTML = `
    <button class="menu" aria-label="Toggle location summary">☰</button>

    <div class="logo">
      <img src="../assets/logo.png" alt="" class="logo-img"
           onerror="this.style.display='none';this.nextElementSibling.style.display='inline'" />
      <span class="logo-fallback">◐</span>
      <span class="logo-word">LightMatter</span>
    </div>

    <aside class="info panel ${showInfo ? "open" : ""}">
      ${infoBody(state)}
    </aside>

    <div class="rail panel ${railOpen ? "open" : ""}">
      <p class="rail-title">Layers</p>
      <label class="layer">
        <input type="checkbox" id="lp-toggle" ${lightOn ? "checked" : ""} />
        <span>Light pollution</span>
      </label>
      <div class="opacity-row">
        <span>Opacity</span>
        <input type="range" id="lp-opacity" min="0" max="100" value="${Math.round(lightOpacity * 100)}" />
      </div>
      <label class="layer off">
        <input type="checkbox" disabled />
        <span>Aurora <em>on the roadmap</em></span>
      </label>
      <p class="rail-note">
        Cloud cover and eclipses live in the location summary — they read better
        as numbers than as paint spread over a continent.
      </p>
    </div>

    <div class="searchwrap">
      <ul class="suggestions panel" hidden></ul>
      <p class="toast panel" id="toast" hidden></p>
      <div class="search">
        <span class="glyph" aria-hidden="true">⌕</span>
        <input id="q" type="text" placeholder="Enter a city, or click the map"
               autocomplete="off" value="${esc(searchText)}" />
        <span class="divider" aria-hidden="true"></span>
        <button id="locate" class="locate" type="button"
                title="Use my current location" aria-label="Use my current location">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" />
            <circle cx="12" cy="10" r="2.6" />
          </svg>
        </button>
      </div>
    </div>`;

  wire(state);
}

function infoBody(state) {
  if (state.error) {
    return `<p class="eyebrow">Couldn't read the sky</p>
            <p class="lede">${esc(state.error)}</p>`;
  }
  if (state.loading) {
    return `<p class="eyebrow">Reading the sky</p>
            <h2 class="display info-title">${esc(state.label || "")}</h2>
            <p class="lede">Checking cloud cover, moonlight and light pollution…</p>`;
  }
  const d = report;
  if (!d) return "";

  const s = d.stars;
  const moon = d.sources?.moon;

  return `
    <p class="eyebrow">${esc(d.potentialLabel || "")}</p>
    <h2 class="display info-title">${esc(d.label)}</h2>

    <div class="scoreline">
      <div class="scorebox">
        <div class="n" data-band="${band(d.score)}">${d.score ?? "—"}</div>
        <div class="k">Tonight</div>
      </div>
      <div class="scorebox">
        <div class="n" data-band="${band(d.potentialScore)}">${d.potentialScore ?? "—"}</div>
        <div class="k">At its best</div>
      </div>
    </div>

    <p class="headline">${esc(d.headline)}</p>

    ${
      d.bestWindow
        ? `<p class="window mono">BEST WINDOW · ${hour(d.bestWindow.start)}–${hour(d.bestWindow.end)}
           <span class="dim">${d.bestWindow.hours} hr${d.bestWindow.moonFree ? "" : ", moonlit"}</span></p>`
        : `<p class="window mono dim">NO USABLE WINDOW TONIGHT</p>`
    }

    <ul class="targets">
      ${d.targets
        .map(
          (t) =>
            `<li><span>${esc(t.name)}</span><span class="v" data-v="${esc(t.verdict)}">${esc(t.verdict)}</span></li>`
        )
        .join("")}
    </ul>

    <!-- Cloud cover and eclipse info live HERE now rather than as map layers. -->
    <div class="readout mono">
      ${row("Cloud cover", cloudText(d))}
      ${row("Sky brightness", d.sky.effectiveSqm ? `${d.sky.effectiveSqm} mag/arcsec²` : "—")}
      ${row("Stars visible", s ? `${s.visibleTonight.toLocaleString()} · to mag ${s.limitingMagnitude}` : "—")}
      ${row("Moon", moon?.dataAvailable ? `${moon.phaseName} · ${moon.illuminatedFraction}% lit` : "—")}
      ${d.sky.moonPenaltyMagnitudes >= 0.3 ? row("Moon cost", `−${d.sky.moonPenaltyMagnitudes} mag`) : ""}
      ${eclipseRow(moon)}
    </div>

    <p class="attrib">${esc(d.sources?.lightPollution?.attribution || "")}</p>`;
}

const row = (k, v) => `<div class="r"><span class="rk">${esc(k)}</span><span class="rv">${esc(v)}</span></div>`;

function cloudText(d) {
  const c = d.sources?.clouds;
  if (!c || c.error || !c.dataAvailable) return "—";
  return `${c.averageCloudCover}% avg · ${c.verdict}`;
}

// Eclipses are a line in the summary, not a path on the map. We hold eclipse
// TIMES, not ground tracks — drawing a path would mean inventing geometry.
function eclipseRow(moon) {
  const e = moon?.upcomingEclipse;
  if (!e) return "";
  return row(
    "Lunar eclipse",
    `${e.type} in ${e.daysAway}d · ${e.visibleHere ? "visible here" : "not visible here"}`
  );
}

// --- behaviour --------------------------------------------------------------

function wire(state) {
  const input = ui.querySelector("#q");
  const list = ui.querySelector(".suggestions");
  const wrap = ui.querySelector(".searchwrap");

  // The bar stays where it is. An earlier version slid it to the centre of the
  // screen while typing, which was distracting and put it on top of the results
  // it was meant to reveal. Only the dropdown appears, and it opens upward out
  // of flow so it cannot shift the bar either.
  let timer;
  let typing = false;

  input.addEventListener("input", () => {
    searchText = input.value;
    typing = true;
    clearTimeout(timer);
    timer = setTimeout(() => suggest(input.value, list), 250);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      list.hidden = true;
      typing = false;
      search(input.value);
    }
    if (e.key === "Escape") {
      list.hidden = true;
      input.blur();
    }
  });

  // Clicking anywhere else closes the dropdown.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!wrap.contains(e.target)) list.hidden = true;
    },
    { once: true }
  );

  list.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    list.hidden = true;
    select(Number(li.dataset.lat), Number(li.dataset.lon), li.dataset.label);
  });

  // Hover opens the rail on a pointer device; tap opens it on touch. Without
  // the tap fallback the toggles are unreachable on a phone — PRD user story 12.
  const rail = ui.querySelector(".rail");
  rail.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    railOpen = !railOpen;
    rail.classList.toggle("open", railOpen);
  });

  ui.querySelector("#lp-toggle").addEventListener("change", (e) => {
    lightOn = e.target.checked;
    if (!map || !lightLayer) return;
    lightOn ? lightLayer.addTo(map) : map.removeLayer(lightLayer);
  });

  ui.querySelector("#lp-opacity").addEventListener("input", (e) => {
    lightOpacity = Number(e.target.value) / 100;
    if (lightLayer) lightLayer.setOpacity(lightOpacity);
  });

  ui.querySelector(".menu").addEventListener("click", () => {
    infoOpen = !infoOpen;
    render({});
    recentre();
  });

  ui.querySelector("#locate").addEventListener("click", useMyLocation);

  // Keep focus and caret across the re-render, but only while actively typing —
  // stealing focus after a result loads would be obnoxious.
  if (state && state.keepFocus) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// A short message above the search bar. Positioned absolutely, like the
// suggestions list, so showing it cannot shift the bar.
let toastTimer;
function toast(message, ms = 4000) {
  const el = ui.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

// The pin button. Browsers only expose geolocation over HTTPS or on localhost,
// so this works in development and would need a certificate in production.
function useMyLocation() {
  const btn = ui.querySelector("#locate");

  if (!navigator.geolocation) {
    toast("This browser can't share a location.");
    return;
  }

  // Permission prompts and GPS fixes can take several seconds, so the button
  // has to say it is working. Without this the first tap reads as broken.
  btn.classList.add("busy");
  btn.setAttribute("aria-busy", "true");
  toast("Asking your browser for your location…", 12000);

  const done = () => {
    btn.classList.remove("busy");
    btn.removeAttribute("aria-busy");
  };

  navigator.geolocation.getCurrentPosition(
    (position) => {
      done();
      const el = ui.querySelector("#toast");
      if (el) el.hidden = true;
      const { latitude, longitude } = position.coords;
      select(Number(latitude.toFixed(4)), Number(longitude.toFixed(4)), "Your location");
    },
    (err) => {
      done();
      // Name the cause. "Location unavailable" is not actionable; "you denied
      // permission" tells someone exactly what to change.
      const reason =
        err.code === err.PERMISSION_DENIED
          ? "Location permission was denied. Search for a place instead."
          : err.code === err.TIMEOUT
            ? "Timed out finding your location. Try again, or search for a place."
            : "Couldn't determine your location. Search for a place instead.";
      toast(reason, 6000);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

async function suggest(text, list) {
  if (!text.trim() || parseCoordinates(text)) {
    list.hidden = true;
    return;
  }
  try {
    const data = await getJson(`/api/geocode?q=${encodeURIComponent(text)}`);
    if (!data.results.length) {
      list.hidden = true;
      return;
    }
    list.innerHTML = data.results
      .map((p) => {
        const label = [p.name, p.region, p.country].filter(Boolean).join(", ");
        return `<li data-lat="${p.lat}" data-lon="${p.lon}" data-label="${esc(label)}">${esc(label)}</li>`;
      })
      .join("");
    list.hidden = false;
  } catch {
    list.hidden = true;
  }
}

async function search(text) {
  const coords = parseCoordinates(text);
  if (coords) return select(coords.lat, coords.lon, `(${coords.lat}, ${coords.lon})`);

  try {
    const data = await getJson(`/api/geocode?q=${encodeURIComponent(text)}`);
    if (!data.results.length) return;
    const p = data.results[0];
    select(p.lat, p.lon, [p.name, p.region, p.country].filter(Boolean).join(", "));
  } catch (err) {
    infoOpen = true;
    render({ error: err.message });
  }
}

// --- map centring -----------------------------------------------------------

// How much of the viewport the summary panel is covering, in pixels.
// Returns 0 when the panel is closed, or when it goes full-width on a phone
// (where there is no uncovered area to centre within).
function panelOffset() {
  const el = ui.querySelector(".info");
  if (!el || !el.classList.contains("open")) return 0;
  const width = el.getBoundingClientRect().width;
  return width >= window.innerWidth * 0.9 ? 0 : width;
}

// Put a coordinate in the middle of the VISIBLE map — the strip to the right of
// the summary panel — rather than the middle of the map element, which the
// panel is covering.
//
// Done in projected pixel space: project the point at the target zoom, shift it
// left by half the panel width, and unproject. Nudging lat/lon directly would
// be wrong, because a given number of pixels is a different number of degrees
// at every latitude.
function offsetLatLng(lat, lon, zoom) {
  const offset = panelOffset();
  if (!offset) return L.latLng(lat, lon);
  const point = map.project([lat, lon], zoom).subtract([offset / 2, 0]);
  return map.unproject(point, zoom);
}

let lastPoint = null;

function recentre() {
  if (!map || !lastPoint) return;
  const zoom = map.getZoom();
  map.panTo(offsetLatLng(lastPoint.lat, lastPoint.lon, zoom), { animate: true, duration: 0.4 });
}

// --- selecting a location ----------------------------------------------------

async function select(lat, lon, label) {
  infoOpen = true;
  report = null;
  lastPoint = { lat, lon };

  // Show the chosen place in the box, so it reflects the current location
  // rather than whatever fragment was typed to find it.
  searchText = label;

  render({ loading: true, label });

  if (map) {
    if (marker) marker.setLatLng([lat, lon]);
    else
      marker = L.circleMarker([lat, lon], {
        radius: 7,
        color: "#b83533",
        fillColor: "#cf7994",
        weight: 2,
        fillOpacity: 0.5,
      }).addTo(map);

    const zoom = Math.max(map.getZoom(), 7);
    // Wait a frame so the panel has begun opening and its width is measurable.
    requestAnimationFrame(() =>
      map.flyTo(offsetLatLng(lat, lon, zoom), zoom, { duration: 0.9 })
    );
  }

  try {
    const sky = await getJson(`/api/sky?lat=${lat}&lon=${lon}`);
    report = { ...sky, label };
    render({});

    // The name arrives late and never blocks the report.
    getJson(`/api/reverse-geocode?lat=${lat}&lon=${lon}`)
      .then((r) => {
        if (r.label && report) {
          report.label = r.label;
          searchText = r.label;
          render({});
        }
      })
      .catch(() => {});
  } catch (err) {
    render({ error: err.message });
  }
}

// --- map --------------------------------------------------------------------

function initMap() {
  map = L.map("map", { zoomControl: false }).setView([39.5, -98.35], 4);

  // THE READABILITY FIX: three layers instead of two.
  //
  // Previously the base map (with its labels baked in) sat under a 55% overlay,
  // and a brightness filter dimmed the whole tile pane on top of that — so city
  // names were both covered and darkened. Splitting CARTO's basemap into its
  // "no labels" and "only labels" halves lets the light pollution data sit
  // BETWEEN them. Labels then draw over the overlay at full strength, and the
  // overlay opacity can run high without hiding a single place name.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  lightLayer = L.tileLayer("/api/lightpollution/tile/{z}/{x}/{y}.png", {
    maxZoom: 18,
    maxNativeZoom: 8,
    opacity: lightOpacity,
    attribution:
      'Light pollution: <a href="https://doi.org/10.5880/GFZ.1.4.2016.001">Falchi et al. 2016</a> (CC BY-NC 4.0)',
  });
  if (lightOn) lightLayer.addTo(map);

  // Labels get their own pane above the overlay. Pointer events are off so the
  // pane never swallows a map click.
  map.createPane("labels");
  map.getPane("labels").style.zIndex = 650;
  map.getPane("labels").style.pointerEvents = "none";

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png", {
    maxZoom: 18,
    pane: "labels",
  }).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  map.on("click", (e) => {
    const { lat, lon } = normalizeCoords(e.latlng.lat, e.latlng.lng);
    select(lat, lon, `(${lat.toFixed(3)}, ${lon.toFixed(3)})`);
  });
}

// --- scaffolding ------------------------------------------------------------

function showEntry() {
  entry.hidden = false;
}
function hideEntry() {
  entry.hidden = true;
  sessionStorage.setItem("lm-proto-seen", "1");
}

document.getElementById("entry-proceed").addEventListener("click", hideEntry);
entry.addEventListener("click", (e) => {
  if (e.target === entry) hideEntry();
});
document.getElementById("replay").addEventListener("click", () => {
  sessionStorage.removeItem("lm-proto-seen");
  showEntry();
});

if (!["localhost", "127.0.0.1"].includes(location.hostname)) {
  document.getElementById("scaffold").style.display = "none";
}

// --- boot -------------------------------------------------------------------
// Chrome first, unconditionally. Then the map, which is allowed to fail.

render({});
if (sessionStorage.getItem("lm-proto-seen") !== "1") showEntry();

try {
  if (typeof L === "undefined") throw new Error("Leaflet did not load (offline?)");
  initMap();
} catch (err) {
  crash("Map unavailable", err);
}
