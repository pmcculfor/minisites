import { initComments } from "./comments.js";

const TIME_ZONE = "America/Detroit";
const LAST_OPEN_DAY = "2026-09-03";

const CITY = { lat: 42.7875, lon: -86.1089 };
const WAVE_POINT = { lat: 42.9, lon: -86.5 };
const NWS_POINT = { lat: 42.9, lon: -86.27 };

const WMO = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Icy fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Rain showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with hail",
};

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function detroitDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isSiteClosed() {
  const params = new URLSearchParams(location.search);
  if (params.get("previewClosed") === "1") return true;
  return detroitDayKey() > LAST_OPEN_DAY;
}

function compassFromDegrees(deg) {
  if (deg == null || Number.isNaN(Number(deg))) return "";
  const idx = Math.round(Number(deg) / 22.5) % 16;
  return COMPASS[idx];
}

function metersToFeet(meters) {
  return meters * 3.28084;
}

function formatTemp(f) {
  return `${Math.round(f)}°`;
}

function formatWaves(meters) {
  const ft = metersToFeet(meters);
  const ftLabel = ft < 0.15 ? "Calm" : `${ft.toFixed(1)} ft`;
  return { ftLabel, metersLabel: `${meters.toFixed(2)} m` };
}

function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function fetchWithTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function isUsableWave(height, period) {
  if (height == null || Number.isNaN(Number(height))) return false;
  const h = Number(height);
  const p = period == null ? null : Number(period);
  if (h === 0 && (p === 0 || p == null)) return false;
  return true;
}

function parseIsoDuration(duration) {
  if (!duration) return 0;
  const days = duration.match(/(\d+)D/);
  const hours = duration.match(/(\d+)H/);
  const minutes = duration.match(/(\d+)M/);
  return (
    (days ? Number(days[1]) * 86400000 : 0) +
    (hours ? Number(hours[1]) * 3600000 : 0) +
    (minutes ? Number(minutes[1]) * 60000 : 0)
  );
}

function currentGridValue(values, now = new Date()) {
  if (!values?.length) return null;
  for (const item of values) {
    const [startIso, duration] = String(item.validTime || "").split("/");
    const start = new Date(startIso);
    const end = new Date(start.getTime() + parseIsoDuration(duration));
    if (now >= start && now < end) return item.value;
  }
  return values[0]?.value ?? null;
}

async function fetchWeather() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(CITY.lat));
  url.searchParams.set("longitude", String(CITY.lon));
  url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", TIME_ZONE);

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
  const data = await res.json();
  const current = data.current;
  if (!current) throw new Error("Weather response was missing current conditions.");
  return {
    temperatureF: current.temperature_2m,
    weatherCode: current.weather_code,
    windMph: current.wind_speed_10m,
    windDir: current.wind_direction_10m,
    time: current.time,
    source: "Open-Meteo",
  };
}

async function fetchOpenMeteoWaves(model) {
  const url = new URL("https://marine-api.open-meteo.com/v1/marine");
  url.searchParams.set("latitude", String(WAVE_POINT.lat));
  url.searchParams.set("longitude", String(WAVE_POINT.lon));
  url.searchParams.set("current", "wave_height,wave_period,wave_direction");
  url.searchParams.set("timezone", TIME_ZONE);
  url.searchParams.set("models", model);

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Marine request failed (${res.status})`);
  const data = await res.json();
  const current = data.current || {};
  if (!isUsableWave(current.wave_height, current.wave_period)) return null;
  return {
    heightM: Number(current.wave_height),
    periodS: current.wave_period == null ? null : Number(current.wave_period),
    direction: current.wave_direction == null ? null : Number(current.wave_direction),
    time: current.time,
    source: `Open-Meteo ${model}`,
  };
}

async function fetchNwsWaves() {
  const pointsUrl = `https://api.weather.gov/points/${NWS_POINT.lat},${NWS_POINT.lon}`;
  const pointsRes = await fetchWithTimeout(pointsUrl, { headers: { Accept: "application/geo+json" } });
  if (!pointsRes.ok) throw new Error(`NWS points failed (${pointsRes.status})`);
  const points = await pointsRes.json();
  const gridUrl = points.properties?.forecastGridData;
  if (!gridUrl) throw new Error("NWS did not return grid data.");

  const gridRes = await fetchWithTimeout(gridUrl, { headers: { Accept: "application/geo+json" } });
  if (!gridRes.ok) throw new Error(`NWS grid failed (${gridRes.status})`);
  const grid = await gridRes.json();
  const height = currentGridValue(grid.properties?.waveHeight?.values);
  const period = currentGridValue(grid.properties?.wavePeriod?.values);
  if (height == null) return null;
  return {
    heightM: Number(height),
    periodS: period == null ? null : Number(period),
    direction: null,
    time: new Date().toISOString(),
    source: "National Weather Service",
  };
}

async function fetchWaves() {
  const ecmwf = await fetchOpenMeteoWaves("ecmwf_wam025").catch(() => null);
  if (ecmwf) return ecmwf;

  const gfs = await fetchOpenMeteoWaves("ncep_gfswave025").catch(() => null);
  if (gfs) return gfs;

  const nws = await fetchNwsWaves().catch(() => null);
  if (nws) return nws;

  throw new Error("No wave forecast was available for this location.");
}

function showError(message) {
  const loading = document.getElementById("conditions-loading");
  const error = document.getElementById("conditions-error");
  const data = document.getElementById("conditions-data");
  const card = document.getElementById("conditions");
  loading.hidden = true;
  data.hidden = true;
  error.hidden = false;
  error.textContent = message;
  card.setAttribute("aria-busy", "false");
}

function showConditions(weather, waves) {
  const loading = document.getElementById("conditions-loading");
  const error = document.getElementById("conditions-error");
  const data = document.getElementById("conditions-data");
  const card = document.getElementById("conditions");

  if (weather) {
    document.getElementById("temp").textContent = formatTemp(weather.temperatureF);
    document.getElementById("wx-desc").textContent = WMO[weather.weatherCode] || "Conditions unavailable";
    const windFrom = compassFromDegrees(weather.windDir);
    document.getElementById("wind").textContent = windFrom
      ? `Wind ${Math.round(weather.windMph)} mph from the ${windFrom}`
      : `Wind ${Math.round(weather.windMph)} mph`;
  } else {
    document.getElementById("temp").textContent = "—";
    document.getElementById("wx-desc").textContent = "Weather unavailable";
    document.getElementById("wind").textContent = "";
  }

  if (waves) {
    const wave = formatWaves(waves.heightM);
    document.getElementById("waves").textContent = wave.ftLabel;
    const waveBits = [wave.metersLabel];
    if (waves.periodS) waveBits.push(`${waves.periodS.toFixed(1)} s period`);
    const from = compassFromDegrees(waves.direction);
    if (from) waveBits.push(`from ${from}`);
    document.getElementById("wave-meta").textContent = waveBits.join(" · ");
  } else {
    document.getElementById("waves").textContent = "—";
    document.getElementById("wave-meta").textContent = "Wave forecast unavailable";
  }

  const asOfBits = [];
  if (weather?.time) asOfBits.push(`As of ${formatWhen(weather.time)}`);
  if (weather) asOfBits.push(`weather ${weather.source}`);
  if (waves) asOfBits.push(`waves ${waves.source}`);
  document.getElementById("as-of").textContent = asOfBits.join(" · ");

  loading.hidden = true;
  error.hidden = true;
  data.hidden = false;
  card.setAttribute("aria-busy", "false");
}

async function loadConditions() {
  const [weatherResult, wavesResult] = await Promise.allSettled([fetchWeather(), fetchWaves()]);
  const weather = weatherResult.status === "fulfilled" ? weatherResult.value : null;
  const waves = wavesResult.status === "fulfilled" ? wavesResult.value : null;

  if (weatherResult.status === "rejected") console.error(weatherResult.reason);
  if (wavesResult.status === "rejected") console.error(wavesResult.reason);

  if (!weather && !waves) {
    showError("Could not load Holland conditions. Refresh the page to try again.");
    return;
  }
  showConditions(weather, waves);
}

function applyClosedState(closed) {
  document.getElementById("closed").hidden = !closed;
  document.getElementById("live").hidden = closed;
}

const closed = isSiteClosed();
applyClosedState(closed);
if (!closed) {
  loadConditions();
}
initComments({ closed });
