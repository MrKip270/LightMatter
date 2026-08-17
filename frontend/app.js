// LightMatter — frontend
//
// Map-first: the map is the page, and everything else is chrome over it.
//
// BOOT ORDER MATTERS. The interface renders before the map is touched, and map
// setup is wrapped in try/catch. Layout must not depend on Leaflet loading or
// the network succeeding — a failure there should cost the map, not the page.
//
// Pure logic lives in coords.js and format.js, which have no DOM access and are
// covered by the test suite. This file is the DOM wiring.

const noticeEl = document.getElementById("notice");
const ui = document.getElementById("ui");
const entry = document.getElementById("entry");

const SEEN_KEY = "lightmatter.introSeen";

let map = null;
let marker = null;
let lightLayer = null;
let lightOn = true;
let lightOpacity = 0.35;
let legendStops = null;

let auroraLayer = null;
// Off by default: unlike light pollution, aurora probability is near-zero
// almost everywhere almost all the time, so defaulting it on would show most
// visitors a mostly-empty layer before they've asked for it.
let auroraOn = false;
let auroraOpacity = 0.85;
let auroraLegendStops = null;
let auroraForecastTime = null;

let report = null; // latest /api/sky result
let searchText = "";
let railOpen = false;
let infoOpen = false;
let lastPoint = null;

let darkSitePopupOpen = false; // is the inline "find a darker sky" popup expanded
let darkSiteSearch = null; // null when idle; { mode: "tonight" | "nearby" } while a search is in flight
let darkSiteRequestId = 0; // bumped on every select() and every dark-site search — stale-result guard

// --- helpers ----------------------------------------------------------------

// Place names come from external APIs and from what the user typed, so they are
// escaped before ever reaching innerHTML. Setting textContent on a throwaway
// element lets the browser do it correctly rather than hand-rolling replacements.
function esc(value) {
  const el = document.createElement("div");
  el.textContent = String(value ?? "");
  return el.innerHTML;
}

function notice(message, ms = 6000) {
  noticeEl.textContent = message;
  noticeEl.hidden = false;
  if (ms) setTimeout(() => (noticeEl.hidden = true), ms);
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

// --- rendering --------------------------------------------------------------
//
// One template, re-rendered on every state change. At this size a full
// re-render is imperceptible and it removes every class of stale-DOM bug.

function render(state = {}) {
  const showInfo = infoOpen && (report || state.loading || state.error);

  ui.innerHTML = `
    <button class="menu" aria-label="${showInfo ? "Hide" : "Show"} location summary"
            aria-expanded="${showInfo}">☰</button>

    <div class="logo">
      <svg class="logo-img" viewBox="0 0 100 100" fill="none" aria-hidden="true" focusable="false">
        <ellipse cx="50" cy="50" rx="18" ry="40" stroke="var(--text)" stroke-width="4" />
        <ellipse cx="50" cy="50" rx="18" ry="40" stroke="var(--text)" stroke-width="4" transform="rotate(60 50 50)" />
        <ellipse cx="50" cy="50" rx="18" ry="40" stroke="var(--text)" stroke-width="4" transform="rotate(120 50 50)" />
        <g transform="translate(50 50) scale(1.41667) translate(-12 -12)" fill="var(--crimson)">
          <path d="M12,24C5.4,24,0,18.6,0,12S5.4,0,12,0s12,5.4,12,12S18.6,24,12,24z M2.2,10C2.1,10.6,2,11.3,2,12c0,5.5,4.5,10,10,10 c0.2,0,0.3,0,0.5,0c-0.3-0.5-0.5-1.2-0.5-2.1c0-0.7-0.3-0.9-1-1.3C9.7,18,8.4,17,9.4,14.2c0-0.1-0.4-0.2-0.6-0.3 c-1.1-0.3-1.4-1.2-1.5-1.8c-0.1-0.4-0.2-0.9-0.6-1.2C6,10.2,3.7,9.9,2.2,10z M9.3,12c0.3,0.1,1.3,0.4,1.8,1.3 c0.3,0.5,0.3,1,0.1,1.6c-0.5,1.4-0.3,1.5,0.6,1.9c0.8,0.4,2.2,1.1,2.2,3.1c0,0.5,0.1,1,0.4,1.3c0.2,0.2,0.3,0.3,0.5,0.3 c0.4,0,0.4-0.5,0.4-0.7c0-1.6,0.8-2.8,1.4-3.8c0.4-0.7,0.8-1.3,0.8-1.8c0-0.7-0.4-1-1.4-1.4c-0.3-0.1-0.6-0.3-0.9-0.4 c-0.3-0.2-0.6-0.4-0.9-0.6c-0.6-0.5-1-0.8-2.3-0.8h-0.4l-0.3-0.3c-0.6-0.5-2.3-2-1.2-4.2c0.3-0.6,0.8-1,1.2-1.3 c0.7-0.5,1.1-0.8,1.1-2.1c0-1.1-1-2.1-1.5-2.1C7.3,2.4,4.2,4.7,2.8,7.9c1.5,0,4.1,0.2,5.3,1.6c0.7,0.7,0.9,1.5,1,2.1 C9.2,11.8,9.3,11.9,9.3,12z M12.4,10c1.6,0.1,2.4,0.6,3.1,1.1c0.2,0.2,0.4,0.3,0.7,0.4c0.2,0.1,0.4,0.2,0.7,0.3 c1,0.5,2.6,1.2,2.6,3.3c0,1.2-0.6,2.1-1.1,2.9c-0.5,0.8-1,1.5-1,2.4c2.7-1.7,4.6-4.8,4.6-8.4c0-4.9-3.5-8.9-8.1-9.8 c0.3,0.6,0.5,1.3,0.5,2c0,2.3-1.2,3.2-2,3.7c-0.3,0.2-0.5,0.4-0.6,0.5C11.7,8.8,11.6,9.2,12.4,10z" />
        </g>
        <g stroke="var(--rose)" stroke-width="2.4" stroke-linecap="round">
          <g transform="translate(50 90)">
            <line x1="-6" y1="0" x2="6" y2="0" />
            <line x1="-6" y1="0" x2="6" y2="0" transform="rotate(60)" />
            <line x1="-6" y1="0" x2="6" y2="0" transform="rotate(120)" />
          </g>
          <g transform="rotate(60 50 50) translate(50 10)">
            <line x1="-6" y1="0" x2="6" y2="0" />
            <line x1="-6" y1="0" x2="6" y2="0" transform="rotate(60)" />
            <line x1="-6" y1="0" x2="6" y2="0" transform="rotate(120)" />
          </g>
          <g transform="rotate(120 50 50) translate(50 90)">
            <line x1="-6" y1="0" x2="6" y2="0" />
            <line x1="-6" y1="0" x2="6" y2="0" transform="rotate(60)" />
            <line x1="-6" y1="0" x2="6" y2="0" transform="rotate(120)" />
          </g>
        </g>
      </svg>
      <span class="logo-word">LightMatter</span>
    </div>

    <aside class="info panel ${showInfo ? "open" : ""}" aria-live="polite" aria-label="Location summary">
      <button class="info-close" type="button" aria-label="Close location summary">×</button>
      ${infoBody(state)}
    </aside>

    <div class="rail panel ${railOpen ? "open" : ""}">
      <button class="rail-tab" type="button"
              aria-label="${railOpen ? "Close" : "Open"} layers"
              aria-expanded="${railOpen}">
        <span class="rail-tab-text">Layers</span>
      </button>
      <p class="rail-title">Layers</p>
      <label class="layer">
        <input type="checkbox" id="lp-toggle" ${lightOn ? "checked" : ""} />
        <span>Light pollution</span>
      </label>
      <div class="opacity-row">
        <label for="lp-opacity">Opacity</label>
        <input type="range" id="lp-opacity" min="0" max="100"
               value="${Math.round(lightOpacity * 100)}" />
      </div>
      ${legendMarkup()}
      <label class="layer">
        <input type="checkbox" id="aurora-toggle" ${auroraOn ? "checked" : ""} />
        <span>Aurora</span>
      </label>
      <div class="opacity-row">
        <label for="aurora-opacity">Opacity</label>
        <input type="range" id="aurora-opacity" min="0" max="100"
               value="${Math.round(auroraOpacity * 100)}" />
      </div>
      ${auroraLegendMarkup()}
      <p class="rail-note">
        Cloud cover and eclipses appear in the location summary — they read
        better as numbers than as paint spread over a continent.
      </p>
    </div>

    ${!report && !state.loading ? `<p class="map-hint" aria-hidden="true">Search a city or click the map</p>` : ""}

    <div class="searchwrap">
      <ul class="suggestions panel" id="suggestions" hidden role="listbox"></ul>
      <p class="toast panel" id="toast" hidden></p>
      <div class="search">
        <span class="glyph" aria-hidden="true">⌕</span>
        <input id="q" type="text" placeholder="Enter a city, or click the map"
               autocomplete="off" aria-label="Search for a place"
               role="combobox" aria-expanded="false"
               aria-controls="suggestions" aria-autocomplete="list"
               value="${esc(searchText)}" />
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

// The colour key is built from the server's palette, so it cannot drift out of
// sync with what the tiles actually draw.
function legendMarkup() {
  if (!legendStops) return "";
  const swatches = [...legendStops]
    .reverse() // darkest first — "where is it good?" is the question being asked
    .map(
      (stop) =>
        `<span class="swatch"><span class="chip" style="background:${esc(stop.colour)}"></span>${stop.sqm.toFixed(1)}</span>`
    )
    .join("");
  return `<div class="legend">
            <div class="swatches">${swatches}</div>
            <p class="legend-note">Sky brightness, mag/arcsec² — higher is darker.</p>
          </div>`;
}

// Same drift-proof idea as legendMarkup(), against the aurora tile palette.
// Swatches use the actual rgba() the tiles draw, so a near-0% stop reads as
// the faint chip it really is rather than a fabricated "off" colour.
function auroraLegendMarkup() {
  if (!auroraLegendStops) return "";
  const swatches = auroraLegendStops
    .map(
      (stop) =>
        `<span class="swatch"><span class="chip" style="background:${esc(stop.colour)}"></span>${stop.probability}%</span>`
    )
    .join("");
  // Unlike Open-Meteo's naive local-time strings (see clouds handling),
  // NOAA's forecastTime is a genuine UTC instant ("...Z"), so new Date() is
  // the CORRECT way to read it — it converts to whatever timezone the
  // visitor's browser is already in, which is what "Forecast for X" should
  // mean to them.
  const asOf = auroraForecastTime
    ? `<p class="legend-note">Forecast for ${esc(
        new Date(auroraForecastTime).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      )} your time.</p>`
    : "";
  return `<div class="legend">
            <div class="swatches">${swatches}</div>
            <p class="legend-note">Aurora visibility probability. Live — updates every few minutes.</p>
            ${asOf}
          </div>`;
}

function infoBody(state) {
  if (state.error) {
    return `<p class="eyebrow">Couldn’t read the sky</p>
            <p class="lede">${esc(state.error)}</p>`;
  }
  if (state.loading) {
    return `<p class="eyebrow">Reading the sky</p>
            <h2 class="display info-title">${esc(state.label || "")}</h2>
            <div class="scoreline">
              <div class="scorebox"><div class="skeleton sk-score"></div><div class="skeleton sk-label"></div></div>
              <div class="scorebox"><div class="skeleton sk-score"></div><div class="skeleton sk-label"></div></div>
            </div>
            <div class="skeleton sk-line" style="width:80%;margin-top:1.1rem"></div>
            <div class="skeleton sk-line" style="width:55%;margin-top:0.4rem"></div>
            <div class="skeleton sk-line" style="width:38%;margin-top:1.2rem"></div>`;
  }
  if (!report) return "";

  const d = report;
  const stars = d.stars;
  const moon = d.sources?.moon;
  const eclipse = formatEclipse(moon?.upcomingEclipse);

  return `
    <p class="eyebrow">${esc(d.potentialLabel || "")}</p>
    <h2 class="display info-title">${esc(d.label)}</h2>

    ${d.darkSite ? darkSiteDisclaimer(d.darkSite) : ""}

    <div class="scoreline">
      <div class="scorebox">
        <div class="n" data-band="${scoreBand(d.score)}">${d.score ?? "—"}</div>
        <div class="k">Tonight</div>
      </div>
      <div class="scorebox">
        <div class="n" data-band="${scoreBand(d.potentialScore)}">${d.potentialScore ?? "—"}</div>
        <div class="k">At its best</div>
      </div>
    </div>

    ${darkSiteButtonMarkup()}

    <p class="headline">${esc(d.headline)}</p>

    ${
      d.bestWindow
        ? `<div class="window-card">
             <div class="k">Best window tonight</div>
             <div class="window-time">${formatHour(d.bestWindow.start)} – ${formatHour(d.bestWindow.end)}</div>
             <div class="k">${d.bestWindow.hours} hr${d.bestWindow.moonFree ? "" : " · moonlit"}</div>
           </div>`
        : `<p class="window mono dim">No usable window tonight</p>`
    }

    <ul class="targets">
      ${d.targets
        .map(
          (t) =>
            `<li><span>${esc(t.name)}</span><span class="v" data-v="${esc(t.verdict)}">${esc(t.verdict)}</span></li>`
        )
        .join("")}
    </ul>

    <div class="readout mono">
      ${row("Cloud cover", formatCloud(d.sources?.clouds))}
      ${row("Sky brightness", d.sky.effectiveSqm ? `${d.sky.effectiveSqm} mag/arcsec²` : "—")}
      ${row("Stars visible", stars ? `${formatCount(stars.visibleTonight)} · to mag ${stars.limitingMagnitude}` : "—")}
      ${row("Moon", moon?.dataAvailable ? `${moon.phaseName} · ${moon.illuminatedFraction}% lit` : "—")}
      ${d.sky.moonPenaltyMagnitudes >= 0.3 ? row("Moon cost", `−${d.sky.moonPenaltyMagnitudes} mag`) : ""}
      ${eclipse ? row("Lunar eclipse", eclipse) : ""}
    </div>

    <p class="attrib">${esc(d.sources?.lightPollution?.attribution || "")}</p>`;
}

const row = (key, value) =>
  `<div class="r"><span class="rk">${esc(key)}</span><span class="rv">${esc(value)}</span></div>`;

// The button lives directly below the current location's scores, and its
// inline popup (not a floating overlay — nothing here anchors a popup to an
// arbitrary button inside a scrolling panel) offers the two search modes.
function darkSiteButtonMarkup() {
  return `
    <button type="button" class="darksite-toggle"
            aria-expanded="${darkSitePopupOpen}" aria-controls="darksite-popup">
      Find a darker sky
    </button>
    <div class="darksite-popup" id="darksite-popup" ${darkSitePopupOpen ? "" : "hidden"}>
      ${
        darkSiteSearch
          ? `<p class="darksite-status mono dim">
               ${
                 darkSiteSearch.mode === "tonight"
                   ? "Checking tonight's forecast at nearby dark sites…"
                   : "Searching for the nearest dark-enough site…"
               }
             </p>`
          : `<p class="darksite-lede dim">Search nearby for a darker sky.</p>
             <div class="darksite-options">
               <button type="button" class="darksite-option darksite-tonight">Best site tonight</button>
               <button type="button" class="darksite-option darksite-nearby">Best nearby site</button>
             </div>`
      }
    </div>`;
}

// Threshold below which "X km away" reads as noise rather than information —
// the grid's own cell resolution is ~7km, so anything under this is
// effectively "you were already there".
const DARKSITE_NEAR_ZERO_KM = 5;

// Rendered on the SUGGESTED site's own summary, explaining why it's here and
// where it came from. Reuses the backend's own fallback message verbatim for
// the unmatched-weather case — same "name the actual limiting factor" ethos
// as buildHeadline() in sky.js, rather than glossing over a fallback as if it
// were a real match.
function darkSiteDisclaimer(ds) {
  const originLabel = esc(ds.origin.label);
  const km = ds.distanceKm;

  let body;
  if (km < DARKSITE_NEAR_ZERO_KM) {
    body = `You were already close to a qualifying dark site — this spot is only ${km} km from ${originLabel}.`;
  } else if (ds.mode === "tonight" && ds.weatherMatched === false) {
    body =
      `${esc(ds.weatherMessage || "No clear weather among the nearest dark-enough sites tonight")} — ` +
      `this is the closest one anyway, ${km} km from ${originLabel}. Expect ${esc(formatCloud(ds.weather))}.`;
  } else if (ds.mode === "tonight") {
    body = `The nearest site with clear, dark skies tonight — ${km} km from ${originLabel}.`;
  } else {
    body =
      `The nearest site dark enough to qualify — ${km} km from ${originLabel}. ` +
      `This search only checked darkness, not tonight's weather — see cloud cover below.`;
  }

  return `<div class="darksite-disclaimer">
    <p>${body}</p>
    <button type="button" class="darksite-back">← Back to ${originLabel}</button>
  </div>`;
}

// --- wiring -----------------------------------------------------------------

function wire(state) {
  const input = ui.querySelector("#q");
  const list = ui.querySelector("#suggestions");
  const wrap = ui.querySelector(".searchwrap");

  let focusedIdx = -1;

  function setFocused(idx) {
    const items = list.querySelectorAll("li");
    if (focusedIdx >= 0 && items[focusedIdx]) {
      items[focusedIdx].setAttribute("aria-selected", "false");
    }
    focusedIdx = idx;
    if (focusedIdx >= 0 && items[focusedIdx]) {
      items[focusedIdx].setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", items[focusedIdx].id);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  new MutationObserver(() => {
    input.setAttribute("aria-expanded", String(!list.hidden));
    if (list.hidden) setFocused(-1);
  }).observe(list, { attributes: true, attributeFilter: ["hidden"] });

  let timer;
  input.addEventListener("input", () => {
    searchText = input.value;
    setFocused(-1);
    clearTimeout(timer);
    timer = setTimeout(() => suggest(input.value, list), 250);
  });

  input.addEventListener("keydown", (event) => {
    const items = list.querySelectorAll("li");
    if (!list.hidden && items.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocused(Math.min(focusedIdx + 1, items.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocused(Math.max(focusedIdx - 1, -1));
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const active = focusedIdx >= 0 ? items[focusedIdx] : null;
      list.hidden = true;
      if (active) {
        select(Number(active.dataset.lat), Number(active.dataset.lon), active.dataset.label);
      } else {
        search(input.value);
      }
    }
    if (event.key === "Escape") {
      list.hidden = true;
      input.blur();
    }
  });

  list.addEventListener("click", (event) => {
    const item = event.target.closest("li");
    if (!item) return;
    list.hidden = true;
    select(Number(item.dataset.lat), Number(item.dataset.lon), item.dataset.label);
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!wrap.contains(event.target)) list.hidden = true;
    },
    { once: true }
  );

  // Hover opens the rail on a pointer device; tap opens it on touch. Without
  // the tap fallback the layer controls are unreachable on a phone.
  const rail = ui.querySelector(".rail");
  const railTab = rail.querySelector(".rail-tab");

  function setRailOpen(open) {
    railOpen = open;
    rail.classList.toggle("open", railOpen);
    railTab.setAttribute("aria-expanded", railOpen);
  }

  // The tab button is the one accessible, keyboard-operable control — it owns
  // open AND close. The div-wide listener below is a mouse-only convenience
  // (click blank space to dismiss) layered on top, never the only way in.
  railTab.addEventListener("click", () => setRailOpen(!railOpen));

  rail.addEventListener("click", (event) => {
    if (!railOpen) return;
    if (event.target.closest(".rail-tab, input, label")) return;
    setRailOpen(false);
  });

  ui.querySelector("#lp-toggle").addEventListener("change", (event) => {
    lightOn = event.target.checked;
    if (!map || !lightLayer) return;
    lightOn ? lightLayer.addTo(map) : map.removeLayer(lightLayer);
  });

  ui.querySelector("#lp-opacity").addEventListener("input", (event) => {
    lightOpacity = Number(event.target.value) / 100;
    if (lightLayer) lightLayer.setOpacity(lightOpacity);
  });

  ui.querySelector("#aurora-toggle").addEventListener("change", (event) => {
    auroraOn = event.target.checked;
    if (!map || !auroraLayer) return;
    auroraOn ? auroraLayer.addTo(map) : map.removeLayer(auroraLayer);
  });

  ui.querySelector("#aurora-opacity").addEventListener("input", (event) => {
    auroraOpacity = Number(event.target.value) / 100;
    if (auroraLayer) auroraLayer.setOpacity(auroraOpacity);
  });

  ui.querySelector(".menu").addEventListener("click", () => {
    infoOpen = !infoOpen;
    render({});
    // Wait a frame so the panel has begun opening and its width is measurable —
    // same reasoning as the flyTo call in select().
    requestAnimationFrame(recentre);
  });

  ui.querySelector(".info-close").addEventListener("click", () => {
    infoOpen = false;
    render({});
    requestAnimationFrame(recentre);
  });

  ui.querySelector("#locate").addEventListener("click", useMyLocation);

  const dsToggle = ui.querySelector(".darksite-toggle");
  if (dsToggle) {
    dsToggle.addEventListener("click", () => {
      darkSitePopupOpen = !darkSitePopupOpen;
      render({});
    });
  }

  const dsTonight = ui.querySelector(".darksite-tonight");
  if (dsTonight) dsTonight.addEventListener("click", () => runDarkSiteSearch("tonight"));

  const dsNearby = ui.querySelector(".darksite-nearby");
  if (dsNearby) dsNearby.addEventListener("click", () => runDarkSiteSearch("nearby"));

  const dsBack = ui.querySelector(".darksite-back");
  if (dsBack) {
    dsBack.addEventListener("click", () => {
      const origin = report?.darkSite?.origin;
      if (origin) select(origin.lat, origin.lon, origin.label);
    });
  }

  if (state && state.keepFocus) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// A short message above the search bar. Positioned out of flow, like the
// suggestions list, so showing it can never shift the bar.
let toastTimer;
function toast(message, ms = 4000) {
  const el = ui.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// --- location ---------------------------------------------------------------

// Browsers only expose geolocation over HTTPS or on localhost.
function useMyLocation() {
  const button = ui.querySelector("#locate");

  if (!navigator.geolocation) {
    toast("This browser can’t share a location.");
    return;
  }

  // A permission prompt or GPS fix takes seconds. Without a visible working
  // state the first tap reads as a dead button.
  button.classList.add("busy");
  button.setAttribute("aria-busy", "true");
  toast("Asking your browser for your location…", 12000);

  const finish = () => {
    button.classList.remove("busy");
    button.removeAttribute("aria-busy");
  };

  navigator.geolocation.getCurrentPosition(
    (position) => {
      finish();
      const el = ui.querySelector("#toast");
      if (el) el.hidden = true;
      const { latitude, longitude } = position.coords;
      select(Number(latitude.toFixed(4)), Number(longitude.toFixed(4)), "Your location");
    },
    (err) => {
      finish();
      // Name the cause. "Location unavailable" is not actionable; "you denied
      // permission" tells someone exactly what to change.
      const reason =
        err.code === err.PERMISSION_DENIED
          ? "Location permission was denied. Search for a place instead."
          : err.code === err.TIMEOUT
            ? "Timed out finding your location. Try again, or search for a place."
            : "Couldn’t determine your location. Search for a place instead.";
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
      .map((place, i) => {
        const label = [place.name, place.region, place.country].filter(Boolean).join(", ");
        return `<li id="suggestion-${i}" role="option" aria-selected="false"
                    data-lat="${place.lat}" data-lon="${place.lon}"
                    data-label="${esc(label)}">${esc(label)}</li>`;
      })
      .join("");
    list.hidden = false;
  } catch {
    // Suggestions are a convenience. If they fail, the search button still works.
    list.hidden = true;
  }
}

async function search(text) {
  const coords = parseCoordinates(text);
  if (coords) return select(coords.lat, coords.lon, `(${coords.lat}, ${coords.lon})`);
  if (!text.trim()) return;

  try {
    const data = await getJson(`/api/geocode?q=${encodeURIComponent(text)}`);
    if (!data.results.length) {
      toast(`No place found for "${text.trim()}".`);
      return;
    }
    const place = data.results[0];
    select(place.lat, place.lon, [place.name, place.region, place.country].filter(Boolean).join(", "));
  } catch (err) {
    infoOpen = true;
    render({ error: err.message });
  }
}

// --- map centring -----------------------------------------------------------

// How much of the viewport the summary panel covers, in pixels. Zero when it is
// closed, or when it goes full-width on a phone (no uncovered area to centre in).
function panelOffset() {
  const el = ui.querySelector(".info");
  if (!el || !el.classList.contains("open")) return 0;
  const width = el.getBoundingClientRect().width;
  return width >= window.innerWidth * 0.9 ? 0 : width;
}

// Put a coordinate in the middle of the VISIBLE map — the strip beside the
// summary panel — rather than the middle of the map element, which the panel is
// covering.
//
// Done in projected pixel space. Nudging lat/lon directly would be wrong: a
// given number of pixels is a different number of degrees at every latitude, so
// an offset tuned for Chicago would misbehave in Tromsø.
function offsetLatLng(lat, lon, zoom) {
  const offset = panelOffset();
  if (!offset || !map) return L.latLng(lat, lon);
  const point = map.project([lat, lon], zoom).subtract([offset / 2, 0]);
  return map.unproject(point, zoom);
}

function recentre() {
  if (!map || !lastPoint) return;
  const zoom = map.getZoom();
  map.panTo(offsetLatLng(lastPoint.lat, lastPoint.lon, zoom), { animate: true, duration: 0.4 });
}

// --- selecting a location ----------------------------------------------------

async function select(lat, lon, label, options = {}) {
  infoOpen = true;
  report = null;
  lastPoint = { lat, lon };
  searchText = label;
  syncUrl(lat, lon);

  // Every navigation — search, map click, a dark-site pick, or a second
  // dark-site search superseding a first — invalidates whatever dark-site
  // search might still be in flight, and starts the popup fresh.
  darkSiteRequestId++;
  darkSitePopupOpen = false;
  darkSiteSearch = null;

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
    requestAnimationFrame(() => map.flyTo(offsetLatLng(lat, lon, zoom), zoom, { duration: 0.9 }));
  }

  try {
    const sky = await getJson(`/api/sky?lat=${lat}&lon=${lon}`);
    report = { ...sky, label, darkSite: options.darkSite ?? null };
    render({});

    // The place name arrives late and never blocks the report.
    getJson(`/api/reverse-geocode?lat=${lat}&lon=${lon}`)
      .then((result) => {
        if (result.label && report) {
          report.label = result.label;
          searchText = result.label;
          render({});
        }
      })
      .catch(() => {});
  } catch (err) {
    render({ error: err.message });
  }
}

// Widens the dark-site search to the nearest few qualifying sites and (for
// "tonight") checks each against the forecast — see backend/sources/darksite.js.
// mode: "tonight" checks the weather too; "nearby" is potential-only, ignoring
// tonight's forecast entirely.
async function runDarkSiteSearch(mode) {
  if (darkSiteSearch || !lastPoint) return; // already searching, or nowhere to search from

  const origin = { lat: lastPoint.lat, lon: lastPoint.lon, label: report?.label ?? searchText };
  const requestId = ++darkSiteRequestId;
  darkSiteSearch = { mode };
  render({});

  const path = mode === "tonight" ? "/api/darksite/tonight" : "/api/darksite";

  try {
    const data = await getJson(`${path}?lat=${origin.lat}&lon=${origin.lon}`);
    if (requestId !== darkSiteRequestId) return; // superseded by a newer search or a navigation — drop silently

    if (!data.dataAvailable || !data.found) {
      // Leave darkSitePopupOpen as-is: the popup reopens to the two choices
      // rather than collapsing, so a retry with the other mode is one click.
      darkSiteSearch = null;
      toast(data.message || "Couldn't find a dark site near here.");
      render({});
      return;
    }

    select(
      data.location.lat,
      data.location.lon,
      `(${data.location.lat.toFixed(3)}, ${data.location.lon.toFixed(3)})`,
      {
        darkSite: {
          origin,
          mode,
          distanceKm: data.distanceKm,
          weatherMatched: mode === "tonight" ? data.weatherMatched : undefined,
          weatherMessage: mode === "tonight" ? data.message : undefined,
          weather: mode === "tonight" ? data.weather : undefined,
        },
      }
    );
  } catch (err) {
    if (requestId !== darkSiteRequestId) return;
    darkSiteSearch = null;
    toast(err.message || "Couldn't reach the dark-site search.");
    render({});
  }
}

// --- map --------------------------------------------------------------------

function initMap() {
  map = L.map("map", { zoomControl: false }).setView([39.5, -98.35], 4);

  // Three layers, not two. The basemap is split into its unlabelled and
  // labels-only halves so the light pollution data can sit BETWEEN them —
  // labels then draw over the overlay at full strength, and the overlay opacity
  // can run high without hiding a single place name.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  lightLayer = L.tileLayer("/api/lightpollution/tile/{z}/{x}/{y}.png", {
    maxZoom: 18,
    // The grid is ~7 km per cell. Past zoom 8 Leaflet upscales rather than
    // requesting detail the data cannot support — honest, and it saves work.
    maxNativeZoom: 8,
    opacity: lightOpacity,
    attribution:
      'Light pollution: <a href="https://doi.org/10.5880/GFZ.1.4.2016.001">Falchi et al. 2016</a> (CC BY-NC 4.0)',
  });
  if (lightOn) lightLayer.addTo(map);

  // Added after lightLayer so it draws above it — a live aurora glow over a
  // static light-pollution wash reads more sensibly than the reverse.
  auroraLayer = L.tileLayer("/api/aurora/tile/{z}/{x}/{y}.png", {
    maxZoom: 18,
    // Coarser grid than light pollution (~111 km vs ~7 km cells), so native
    // detail runs out much sooner — see auroratiles.js for the derivation.
    maxNativeZoom: 4,
    opacity: auroraOpacity,
    attribution: "Aurora: NOAA SWPC OVATION",
  });
  if (auroraOn) auroraLayer.addTo(map);

  map.createPane("labels");
  map.getPane("labels").style.zIndex = 650;
  map.getPane("labels").style.pointerEvents = "none";

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png", {
    maxZoom: 18,
    pane: "labels",
  }).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  map.on("click", (event) => {
    // Leaflet reports the longitude of whichever world copy was clicked, so
    // panning past the dateline yields values outside -180..180.
    const { lat, lon } = normalizeCoords(event.latlng.lat, event.latlng.lng);
    select(lat, lon, `(${lat.toFixed(3)}, ${lon.toFixed(3)})`);
  });
}

async function loadLegend() {
  try {
    const data = await getJson("/api/lightpollution/tile/legend");
    legendStops = data.stops;
    render({});
  } catch {
    // The map works fine without a colour key.
  }
}

// Fetched once at page load, not polled — matches the rest of the site
// having no background refresh anywhere. A long session's timestamp will
// drift from reality, which is an accepted tradeoff, not an oversight.
async function loadAuroraLegend() {
  try {
    const data = await getJson("/api/aurora/tile/legend");
    auroraLegendStops = data.stops;
    auroraForecastTime = data.forecastTime;
    render({});
  } catch {
    // The map works fine without a colour key.
  }
}

// --- URL state ----------------------------------------------------------------
//
// The selected location is reflected in the URL so a report can be shared,
// bookmarked, or survive a reload. replaceState, never pushState — one
// history entry per page load, not one per location searched.

function syncUrl(lat, lon) {
  const url = new URL(window.location.href);
  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lon);
  history.replaceState(null, "", url);
}

function restoreFromUrl() {
  const params = new URLSearchParams(window.location.search);
  // Number(null) is 0, which would otherwise pass the checks below and
  // silently select Null Island on every bare visit to "/".
  if (!params.has("lat") || !params.has("lon")) return;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return;
  select(lat, lon, `(${lat.toFixed(3)}, ${lon.toFixed(3)})`);
}

// --- intro ------------------------------------------------------------------

function hideEntry() {
  entry.hidden = true;
  document.getElementById("q")?.focus();
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Private browsing can block storage. Showing the intro again is harmless.
  }
}

document.getElementById("entry-proceed").addEventListener("click", () => {
  hideEntry();
  render({});
});

entry.addEventListener("click", (event) => {
  if (event.target === entry) hideEntry();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !entry.hidden) hideEntry();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && darkSitePopupOpen) {
    darkSitePopupOpen = false;
    render({});
  }
});

// --- boot -------------------------------------------------------------------

window.addEventListener("error", (event) => {
  console.error(event.error || event);
  notice("Something went wrong. Try reloading the page.", 0);
});

// Interface first, unconditionally. Then the map, which is allowed to fail.
render({});

let introSeen = false;
try {
  introSeen = localStorage.getItem(SEEN_KEY) === "1";
} catch {
  introSeen = false;
}
if (!introSeen) entry.hidden = false;

try {
  if (typeof L === "undefined") throw new Error("Leaflet did not load");
  initMap();
  loadLegend();
  loadAuroraLegend();
} catch (err) {
  console.error(err);
  notice("The map couldn’t load, but search still works.", 0);
}

// Restore a shared/bookmarked location. Runs even if the map failed to load —
// select() itself already tolerates a missing map.
restoreFromUrl();
