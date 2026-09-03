// ── WMO weather code → human-readable description ───────────────────────────

const WMO_CODES = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Icy fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Heavy freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm w/ slight hail",
  99: "Thunderstorm w/ heavy hail",
};

// ── Wind direction degrees → compass label ───────────────────────────────────

function degreesToCompass(deg) {
  if (deg == null || isNaN(deg)) return "";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── C → F conversion ─────────────────────────────────────────────────────────

function cToF(c) {
  return Math.round(c * 9 / 5 + 32);
}

// ── m/s → mph conversion ─────────────────────────────────────────────────────

function msToMph(ms) {
  return Math.round(ms * 2.237);
}

// ── km/h → mph conversion ────────────────────────────────────────────────────

function kmhToMph(kmh) {
  return Math.round(kmh * 0.621371);
}

// ── DOM helper ───────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// ── Geocode ZIP via zippopotam.us ────────────────────────────────────────────

async function geocodeZip(zip) {
  const res = await fetch(`https://api.zippopotam.us/us/${zip}`);
  if (!res.ok) throw new Error(`ZIP code "${zip}" not found.`);
  const data = await res.json();
  const place = data.places[0];
  return {
    lat: parseFloat(place.latitude),
    lon: parseFloat(place.longitude),
    city: `${place["place name"]}, ${place["state abbreviation"]}`,
  };
}

// ── Fetch Open-Meteo ─────────────────────────────────────────────────────────

async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current_weather: "true",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
    timezone: "auto",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error("Open-Meteo request failed.");
  const data = await res.json();
  const cw = data.current_weather;
  const tempF = cToF(cw.temperature);
  const windMph = kmhToMph(cw.windspeed);
  const windDir = degreesToCompass(cw.winddirection);
  const condition = WMO_CODES[cw.weathercode] ?? `Code ${cw.weathercode}`;
  return {
    tempF,
    tempRaw: cw.temperature,   // °C for comparison
    condition,
    windMph,
    windDir,
    windRaw: cw.windspeed,     // km/h for comparison
  };
}

// ── Fetch NWS (two-step) ─────────────────────────────────────────────────────

async function fetchNWS(lat, lon) {
  // Step 1: resolve grid point
  const ptRes = await fetch(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    { headers: { "User-Agent": "minisites-weather-compare (github.com/pmcculfor)" } }
  );
  if (!ptRes.ok) throw new Error("NWS: could not resolve grid point for this location.");
  const ptData = await ptRes.json();

  // Step 2: fetch nearest observation station list
  const stationsUrl = ptData.properties.observationStations;
  const stRes = await fetch(stationsUrl, {
    headers: { "User-Agent": "minisites-weather-compare (github.com/pmcculfor)" },
  });
  if (!stRes.ok) throw new Error("NWS: could not fetch observation stations.");
  const stData = await stRes.json();

  // Try stations in order until one returns a valid observation
  const stations = stData.features ?? stData.observationStations ?? [];
  if (!stations.length) throw new Error("NWS: no observation stations found nearby.");

  let obs = null;
  let lastErr = null;
  for (let i = 0; i < Math.min(5, stations.length); i++) {
    const stId = typeof stations[i] === "string"
      ? stations[i]
      : stations[i]?.properties?.stationIdentifier ?? stations[i]?.id ?? stations[i];
    const obsUrl = typeof stId === "string" && stId.startsWith("http")
      ? `${stId}/observations/latest`
      : `https://api.weather.gov/stations/${stId}/observations/latest`;

    try {
      const obsRes = await fetch(obsUrl, {
        headers: { "User-Agent": "minisites-weather-compare (github.com/pmcculfor)" },
      });
      if (!obsRes.ok) { lastErr = `Station ${stId} returned ${obsRes.status}`; continue; }
      const obsData = await obsRes.json();
      const props = obsData.properties;
      if (props?.temperature?.value == null) { lastErr = `Station ${stId} has no temperature`; continue; }
      obs = props;
      break;
    } catch (e) {
      lastErr = e.message;
    }
  }

  if (!obs) throw new Error(`NWS: no usable observation found. Last error: ${lastErr}`);

  const tempC = obs.temperature.value;
  const tempF = cToF(tempC);
  const condition = obs.textDescription || "N/A";

  const windSpeedMs = obs.windSpeed?.value ?? null;
  const windMph = windSpeedMs != null ? msToMph(windSpeedMs) : null;
  const windDir = degreesToCompass(obs.windDirection?.value ?? null);

  return {
    tempF,
    tempRaw: tempC,
    condition,
    windMph,
    windDir,
    windRaw: windSpeedMs,
  };
}

// ── Render a source card ─────────────────────────────────────────────────────

function setLoading(prefix, isLoading) {
  document.getElementById(`${prefix}-loading`).hidden = !isLoading;
  document.getElementById(`${prefix}-card`).setAttribute("aria-busy", isLoading ? "true" : "false");
}

function showError(prefix, msg) {
  setLoading(prefix, false);
  const errEl = document.getElementById(`${prefix}-error`);
  errEl.textContent = msg;
  errEl.hidden = false;
  document.getElementById(`${prefix}-data`).hidden = true;
}

function showData(prefix, data) {
  setLoading(prefix, false);
  document.getElementById(`${prefix}-error`).hidden = true;

  document.getElementById(`${prefix}-temp`).textContent =
    `${data.tempF}°F`;
  document.getElementById(`${prefix}-cond`).textContent =
    data.condition;
  document.getElementById(`${prefix}-wind`).textContent =
    data.windMph != null
      ? `${data.windMph} mph ${data.windDir}`.trim()
      : "N/A";

  document.getElementById(`${prefix}-data`).hidden = false;
}

// ── Comparison highlights ────────────────────────────────────────────────────

const TEMP_DIFF_THRESHOLD_F = 5;   // flag if temps differ by ≥ 5°F
const WIND_DIFF_THRESHOLD_MPH = 8; // flag if winds differ by ≥ 8 mph

function applyDiffHighlight(omData, nwsData) {
  // Temperature
  const tempDiff = Math.abs(omData.tempF - nwsData.tempF);
  const tempDiffers = tempDiff >= TEMP_DIFF_THRESHOLD_F;
  document.getElementById("om-temp-row").className = `data-row ${tempDiffers ? "diff" : "match"}`;
  document.getElementById("nws-temp-row").className = `data-row ${tempDiffers ? "diff" : "match"}`;

  // Wind speed (only if both sources have a value)
  const windDiffers =
    omData.windMph != null &&
    nwsData.windMph != null &&
    Math.abs(omData.windMph - nwsData.windMph) >= WIND_DIFF_THRESHOLD_MPH;
  document.getElementById("om-wind-row").className = `data-row ${windDiffers ? "diff" : "match"}`;
  document.getElementById("nws-wind-row").className = `data-row ${windDiffers ? "diff" : "match"}`;

  // Conditions: always informational (can't numerically compare)
  document.getElementById("om-cond-row").className = "data-row";
  document.getElementById("nws-cond-row").className = "data-row";

  // Build comparison summary
  buildComparison(omData, nwsData, tempDiff, tempDiffers, windDiffers);
}

function buildComparison(omData, nwsData, tempDiff, tempDiffers, windDiffers) {
  const card = document.getElementById("comparison-card");
  const body = document.getElementById("comparison-body");
  body.innerHTML = "";

  const items = [
    {
      label: "Temperature",
      differs: tempDiffers,
      text: tempDiffers
        ? `Sources differ by ${tempDiff}°F — Open-Meteo reports ${omData.tempF}°F, NWS reports ${nwsData.tempF}°F.`
        : `Both sources agree: approximately ${omData.tempF}°F (within ${tempDiff}°F).`,
    },
    {
      label: "Wind speed",
      differs: windDiffers,
      text: (() => {
        if (omData.windMph == null || nwsData.windMph == null) return "One or more sources did not report wind speed.";
        const diff = Math.abs(omData.windMph - nwsData.windMph);
        return windDiffers
          ? `Sources differ by ${diff} mph — Open-Meteo: ${omData.windMph} mph, NWS: ${nwsData.windMph} mph.`
          : `Both sources agree: approximately ${omData.windMph} mph (within ${diff} mph).`;
      })(),
    },
    {
      label: "Conditions",
      differs: null,  // informational only
      text: `Open-Meteo: "${omData.condition}" · NWS: "${nwsData.condition}"`,
    },
  ];

  for (const item of items) {
    const row = el("div", "comparison-item");
    const badge = el("span", "comparison-badge");
    if (item.differs === null) {
      badge.textContent = "Info";
      badge.className = "comparison-badge badge-info";
      badge.style.background = "#eef3f7";
      badge.style.color = "#4a6074";
    } else if (item.differs) {
      badge.textContent = "Differs";
      badge.className = "comparison-badge badge-differ";
    } else {
      badge.textContent = "Agree";
      badge.className = "comparison-badge badge-agree";
    }
    const text = el("p", "comparison-text", item.text);
    text.style.margin = "0";
    const labelEl = el("strong", "", item.label + ": ");
    text.prepend(labelEl);
    row.append(badge, text);
    body.append(row);
  }

  card.hidden = false;
}

// ── Main lookup flow ─────────────────────────────────────────────────────────

const form = document.getElementById("zip-form");
const zipInput = document.getElementById("zip-input");
const zipError = document.getElementById("zip-error");
const resultsEl = document.getElementById("results");
const locationName = document.getElementById("location-name");
const lookupBtn = form.querySelector(".lookup-btn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const zip = zipInput.value.trim();

  // Reset state
  zipError.hidden = true;
  zipError.textContent = "";
  document.getElementById("comparison-card").hidden = true;
  document.getElementById("om-error").hidden = true;
  document.getElementById("nws-error").hidden = true;
  document.getElementById("om-data").hidden = true;
  document.getElementById("nws-data").hidden = true;
  ["om-temp-row", "nws-temp-row", "om-wind-row", "nws-wind-row", "om-cond-row", "nws-cond-row"].forEach(
    (id) => (document.getElementById(id).className = "data-row")
  );

  // Validate ZIP
  if (!/^\d{5}$/.test(zip)) {
    zipError.textContent = "Please enter a valid 5-digit US ZIP code.";
    zipError.hidden = false;
    return;
  }

  lookupBtn.disabled = true;
  lookupBtn.textContent = "Looking up…";

  // Geocode
  let geo;
  try {
    geo = await geocodeZip(zip);
  } catch (err) {
    zipError.textContent = err.message;
    zipError.hidden = false;
    lookupBtn.disabled = false;
    lookupBtn.textContent = "Look Up";
    return;
  }

  locationName.textContent = `${geo.city} (${zip})`;
  resultsEl.hidden = false;

  // Show loading on both cards
  setLoading("om", true);
  setLoading("nws", true);

  lookupBtn.disabled = false;
  lookupBtn.textContent = "Look Up";

  // Fetch both in parallel
  const [omResult, nwsResult] = await Promise.allSettled([
    fetchOpenMeteo(geo.lat, geo.lon),
    fetchNWS(geo.lat, geo.lon),
  ]);

  const omData = omResult.status === "fulfilled" ? omResult.value : null;
  const nwsData = nwsResult.status === "fulfilled" ? nwsResult.value : null;

  if (omData) {
    showData("om", omData);
  } else {
    showError("om", omResult.reason?.message ?? "Failed to load Open-Meteo data.");
  }

  if (nwsData) {
    showData("nws", nwsData);
  } else {
    showError("nws", nwsResult.reason?.message ?? "Failed to load NWS data.");
  }

  // Apply comparison highlights only when both succeeded
  if (omData && nwsData) {
    applyDiffHighlight(omData, nwsData);
  }
});
