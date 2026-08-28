import { initComments } from "./comments.js";

const TIME_ZONE = "America/Detroit";
const LAST_OPEN_DAY = "2026-09-03";
const FORECAST_DAYS = 7;

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

function formatWaveFt(meters) {
  if (meters == null || Number.isNaN(Number(meters))) return "—";
  const ft = metersToFeet(Number(meters));
  return ft < 0.15 ? "Calm" : `${ft.toFixed(1)} ft`;
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

function dailyMapFromOpenMeteo(daily) {
  const map = {};
  if (!daily?.time) return map;
  daily.time.forEach((dayKey, i) => {
    const height = daily.wave_height_max?.[i];
    const period = daily.wave_period_max?.[i];
    if (!isUsableWave(height, period)) return;
    map[dayKey] = {
      heightM: Number(height),
      periodS: period == null ? null : Number(period),
      direction: daily.wave_direction_dominant?.[i] ?? null,
    };
  });
  return map;
}

async function fetchWeather() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(CITY.lat));
  url.searchParams.set("longitude", String(CITY.lon));
  url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m");
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", TIME_ZONE);
  url.searchParams.set("forecast_days", String(FORECAST_DAYS));

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
  const data = await res.json();
  if (!data.daily?.time?.length) throw new Error("Weather response was missing daily forecast.");
  return {
    current: data.current || null,
    daily: data.daily,
    source: "Open-Meteo",
  };
}

async function fetchOpenMeteoWaves(model) {
  const url = new URL("https://marine-api.open-meteo.com/v1/marine");
  url.searchParams.set("latitude", String(WAVE_POINT.lat));
  url.searchParams.set("longitude", String(WAVE_POINT.lon));
  url.searchParams.set("current", "wave_height,wave_period,wave_direction");
  url.searchParams.set("daily", "wave_height_max,wave_direction_dominant,wave_period_max");
  url.searchParams.set("timezone", TIME_ZONE);
  url.searchParams.set("models", model);
  url.searchParams.set("forecast_days", String(FORECAST_DAYS));

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Marine request failed (${res.status})`);
  const data = await res.json();
  const dailyByDate = dailyMapFromOpenMeteo(data.daily);
  const current = data.current || {};
  const currentUsable = isUsableWave(current.wave_height, current.wave_period)
    ? {
        heightM: Number(current.wave_height),
        periodS: current.wave_period == null ? null : Number(current.wave_period),
        direction: current.wave_direction == null ? null : Number(current.wave_direction),
      }
    : null;
  if (!Object.keys(dailyByDate).length && !currentUsable) return null;
  return {
    current: currentUsable,
    dailyByDate,
    source: `Open-Meteo ${model}`,
  };
}

function nwsDailyByDate(values) {
  const map = {};
  for (const item of values || []) {
    if (item.value == null) continue;
    const [startIso, duration] = String(item.validTime || "").split("/");
    const start = new Date(startIso);
    const end = new Date(start.getTime() + parseIsoDuration(duration) || 3600000);
    for (let t = start.getTime(); t < end.getTime(); t += 3600000) {
      const key = detroitDayKey(new Date(t));
      const prev = map[key];
      if (!prev || Number(item.value) > prev.heightM) {
        map[key] = { heightM: Number(item.value), periodS: null, direction: null };
      }
    }
  }
  return map;
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
  const dailyByDate = nwsDailyByDate(grid.properties?.waveHeight?.values);
  if (!Object.keys(dailyByDate).length) return null;
  const today = dailyByDate[detroitDayKey()] || null;
  return {
    current: today,
    dailyByDate,
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

function formatDayLabel(dayKey, isToday) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 16));
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
  }).format(noon);
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
  }).format(noon);
  return {
    kicker: isToday ? "Today" : weekday,
    date: monthDay,
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildDays(weather, waves) {
  const today = detroitDayKey();
  const dates = weather?.daily?.time?.slice() || Object.keys(waves?.dailyByDate || {}).sort();
  return dates.map((dayKey, i) => {
    const isToday = dayKey === today;
    const waveDay = waves?.dailyByDate?.[dayKey] || null;
    return {
      dayKey,
      isToday,
      weatherCode: weather?.daily?.weather_code?.[i],
      high: weather?.daily?.temperature_2m_max?.[i],
      low: weather?.daily?.temperature_2m_min?.[i],
      windMph: weather?.daily?.wind_speed_10m_max?.[i],
      windDir: weather?.daily?.wind_direction_10m_dominant?.[i],
      currentTemp: isToday ? weather?.current?.temperature_2m : null,
      currentWx: isToday ? weather?.current?.weather_code : null,
      currentWindMph: isToday ? weather?.current?.wind_speed_10m : null,
      currentWindDir: isToday ? weather?.current?.wind_direction_10m : null,
      waveNowM: isToday ? waves?.current?.heightM ?? waveDay?.heightM : null,
      waveMaxM: waveDay?.heightM ?? null,
      wavePeriod: waveDay?.periodS ?? (isToday ? waves?.current?.periodS : null),
      waveDir: waveDay?.direction ?? (isToday ? waves?.current?.direction : null),
    };
  });
}

function weatherClass(code) {
  const n = Number(code);
  if (n === 0) return "wx-clear";
  if (n === 1) return "wx-mostly";
  if (n === 2) return "wx-partly";
  if (n === 3) return "wx-overcast";
  if (n === 45 || n === 48) return "wx-fog";
  if ([51, 53, 55, 56, 57].includes(n)) return "wx-drizzle";
  if ([80, 81].includes(n)) return "wx-showers";
  if (n === 65 || n === 82) return "wx-heavy";
  if ([61, 63, 66, 67].includes(n)) return "wx-rain";
  if ([71, 73, 75, 77, 85, 86].includes(n)) return "wx-snow";
  if ([95, 96, 99].includes(n)) return "wx-thunder";
  return "wx-overcast";
}

function isDarkWeather(wx) {
  return ["wx-rain", "wx-showers", "wx-heavy", "wx-thunder"].includes(wx);
}

function renderTile(day) {
  const wxCode = day.currentWx ?? day.weatherCode;
  const wx = weatherClass(wxCode);
  const classes = ["forecast-tile", wx];
  if (isDarkWeather(wx)) classes.push("wx-dark");
  if (day.isToday) classes.push("is-today");
  const tile = el("article", classes.join(" "));
  tile.setAttribute("aria-label", `Forecast for ${day.dayKey}`);
  const labels = formatDayLabel(day.dayKey, day.isToday);
  tile.append(el("p", "tile-kicker", labels.kicker), el("p", "tile-date", labels.date));

  const headlineTemp = day.currentTemp ?? day.high;
  tile.append(el("p", "tile-temp", headlineTemp == null ? "—" : formatTemp(headlineTemp)));

  if (day.high != null && day.low != null) {
    tile.append(el("p", "tile-range", `H ${formatTemp(day.high)} / L ${formatTemp(day.low)}`));
  }

  tile.append(el("p", "tile-wx", WMO[wxCode] || "—"));

  const waveBits = [];
  if (day.isToday && day.waveNowM != null) {
    waveBits.push(`Now ${formatWaveFt(day.waveNowM)}`);
    if (day.waveMaxM != null) waveBits.push(`max ${formatWaveFt(day.waveMaxM)}`);
  } else if (day.waveMaxM != null) {
    waveBits.push(`Waves ${formatWaveFt(day.waveMaxM)}`);
  } else {
    waveBits.push("Waves —");
  }
  const from = compassFromDegrees(day.waveDir);
  if (from) waveBits.push(from);
  tile.append(el("p", "tile-waves", waveBits.join(" · ")));

  const windSpeed = day.isToday ? day.currentWindMph ?? day.windMph : day.windMph;
  const windDir = day.isToday ? day.currentWindDir ?? day.windDir : day.windDir;
  const windFrom = compassFromDegrees(windDir);
  if (windSpeed != null) {
    tile.append(
      el("p", "tile-wind", windFrom ? `Wind ${Math.round(windSpeed)} mph ${windFrom}` : `Wind ${Math.round(windSpeed)} mph`)
    );
  }
  return tile;
}

function tileStep(scroller) {
  const tile = scroller.querySelector(".forecast-tile");
  if (!tile) return scroller.clientWidth;
  const styles = getComputedStyle(scroller);
  const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0;
  return tile.getBoundingClientRect().width + gap;
}

function updateNav(scroller, prev, next) {
  const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth - 2);
  prev.disabled = scroller.scrollLeft <= 2;
  next.disabled = scroller.scrollLeft >= max;
}

function initCarousel(scroller) {
  const prev = document.getElementById("forecast-prev");
  const next = document.getElementById("forecast-next");
  const sync = () => updateNav(scroller, prev, next);

  prev.addEventListener("click", () => {
    scroller.scrollBy({ left: -tileStep(scroller), behavior: "smooth" });
  });
  next.addEventListener("click", () => {
    scroller.scrollBy({ left: tileStep(scroller), behavior: "smooth" });
  });
  scroller.addEventListener("scroll", sync, { passive: true });
  scroller.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      scroller.scrollBy({ left: -tileStep(scroller), behavior: "smooth" });
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      scroller.scrollBy({ left: tileStep(scroller), behavior: "smooth" });
    }
  });

  let dragging = false;
  let startX = 0;
  let startScroll = 0;
  scroller.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return;
    dragging = true;
    startX = event.clientX;
    startScroll = scroller.scrollLeft;
    scroller.setPointerCapture(event.pointerId);
  });
  scroller.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    scroller.scrollLeft = startScroll - (event.clientX - startX);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    const step = tileStep(scroller);
    const snapped = Math.round(scroller.scrollLeft / step) * step;
    scroller.scrollTo({ left: snapped, behavior: "smooth" });
  };
  scroller.addEventListener("pointerup", endDrag);
  scroller.addEventListener("pointercancel", endDrag);

  sync();
  window.addEventListener("resize", sync);
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

function showForecast(weather, waves) {
  const days = buildDays(weather, waves);
  if (!days.length) {
    showError("Could not load Holland conditions. Refresh the page to try again.");
    return;
  }

  const scroller = document.getElementById("forecast-scroller");
  scroller.replaceChildren(...days.map(renderTile));

  const asOf = [];
  if (weather?.current?.time) {
    const when = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(weather.current.time));
    asOf.push(`Now as of ${when}`);
  }
  if (weather) asOf.push(`weather ${weather.source}`);
  if (waves) asOf.push(`waves ${waves.source}`);
  document.getElementById("as-of").textContent = asOf.join(" · ");

  document.getElementById("conditions-loading").hidden = true;
  document.getElementById("conditions-error").hidden = true;
  document.getElementById("conditions-data").hidden = false;
  document.getElementById("conditions").setAttribute("aria-busy", "false");
  initCarousel(scroller);
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
  showForecast(weather, waves);
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
