import { CONFIG } from "../config.js";
import { fetchJson } from "../lib/http.js";
import { applyOpenMeteoWindow, detroitDayKey } from "../lib/time.js";
import { isUsableProviderResult } from "./waves.js";

const NWS_COMPASS_DEG = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

export function nwsTextToWmo(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return 2;
  if (/thunder|t-storm|tstm/.test(t)) return 95;
  if (/freezing rain/.test(t)) return 66;
  if (/sleet|ice pellet|wintry|rain and snow|snow and rain/.test(t)) return 67;
  if (/blizzard|heavy snow/.test(t)) return 75;
  if (/snow|flurries/.test(t)) return 71;
  if (/heavy rain|downpour/.test(t)) return 65;
  if (/shower/.test(t)) return 80;
  if (/rain|drizzle/.test(t)) return 61;
  if (/fog/.test(t)) return 45;
  if (/\b(overcast|cloudy)\b/.test(t) && !/partly|mostly sunny|mostly clear/.test(t)) return 3;
  if (/partly|mostly cloudy|mostly sunny/.test(t)) return 2;
  if (/clear|sunny|fair/.test(t)) return 0;
  return 2;
}

export function parseNwsWindMph(text) {
  const nums = String(text || "").match(/\d+/g);
  if (!nums || !nums.length) return null;
  return Math.max(...nums.map(Number));
}

export function nwsCompassToDeg(dir) {
  if (!dir) return null;
  const key = String(dir).toUpperCase().replace(/[^A-Z]/g, "");
  return Object.prototype.hasOwnProperty.call(NWS_COMPASS_DEG, key) ? NWS_COMPASS_DEG[key] : null;
}

export function pickHourlyCurrent(periods, now) {
  if (!periods || !periods.length) return null;
  const t = (now || new Date()).getTime();
  let best = periods[0];
  for (let i = 0; i < periods.length; i++) {
    const start = new Date(periods[i].startTime).getTime();
    if (Number.isNaN(start)) continue;
    if (start <= t) best = periods[i];
    else break;
  }
  return best;
}

export function dailyFromNwsForecast(periods, timeZone) {
  const byDay = new Map();
  for (const period of periods || []) {
    if (!period?.startTime) continue;
    const key = detroitDayKey(new Date(period.startTime), timeZone);
    if (!byDay.has(key)) {
      byDay.set(key, {
        highs: [],
        lows: [],
        windMph: [],
        windDir: [],
        codes: [],
        labels: [],
      });
    }
    const bucket = byDay.get(key);
    if (typeof period.temperature === "number") {
      if (period.isDaytime) bucket.highs.push(period.temperature);
      else bucket.lows.push(period.temperature);
    }
    const mph = parseNwsWindMph(period.windSpeed);
    if (mph != null) bucket.windMph.push(mph);
    const deg = nwsCompassToDeg(period.windDirection);
    if (deg != null) bucket.windDir.push(deg);
    if (period.isDaytime) {
      bucket.codes.push(nwsTextToWmo(period.shortForecast));
      if (period.shortForecast) bucket.labels.push(period.shortForecast);
    }
  }

  const daily = {
    time: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    weather_code: [],
    wx_label: [],
    wind_speed_10m_max: [],
    wind_direction_10m_dominant: [],
  };
  for (const key of [...byDay.keys()].sort()) {
    const bucket = byDay.get(key);
    daily.time.push(key);
    daily.temperature_2m_max.push(bucket.highs[0] ?? null);
    daily.temperature_2m_min.push(bucket.lows[0] ?? null);
    daily.weather_code.push(bucket.codes[0] ?? 2);
    daily.wx_label.push(bucket.labels[0] || "");
    daily.wind_speed_10m_max.push(bucket.windMph.length ? Math.max(...bucket.windMph) : null);
    daily.wind_direction_10m_dominant.push(bucket.windDir[0] ?? null);
  }
  return daily;
}

export function applyHourlyExtrema(daily, hourlyPeriods, timeZone) {
  const extrema = new Map();
  for (const period of hourlyPeriods || []) {
    if (typeof period.temperature !== "number" || !period.startTime) continue;
    const key = detroitDayKey(new Date(period.startTime), timeZone);
    const cur = extrema.get(key);
    if (!cur) extrema.set(key, { max: period.temperature, min: period.temperature });
    else {
      cur.max = Math.max(cur.max, period.temperature);
      cur.min = Math.min(cur.min, period.temperature);
    }
  }
  for (let i = 0; i < daily.time.length; i++) {
    const e = extrema.get(daily.time[i]);
    if (!e) continue;
    if (daily.temperature_2m_max[i] == null) daily.temperature_2m_max[i] = e.max;
    if (daily.temperature_2m_min[i] == null) daily.temperature_2m_min[i] = e.min;
  }
  return daily;
}

export function currentFromNwsPeriod(period) {
  if (!period) return null;
  return {
    time: period.startTime || null,
    temperature_2m: typeof period.temperature === "number" ? period.temperature : null,
    weather_code: nwsTextToWmo(period.shortForecast),
    wind_speed_10m: parseNwsWindMph(period.windSpeed),
    wind_direction_10m: nwsCompassToDeg(period.windDirection),
    wx_label: period.shortForecast || "",
  };
}

function nwsCityName(points, fallback) {
  const loc = points?.properties?.relativeLocation?.properties;
  if (loc?.city && loc?.state) return `${loc.city}, ${loc.state}`;
  return fallback || "Holland, MI";
}

export function OpenMeteoWeatherProvider(config) {
  this.config = config || CONFIG;
}

OpenMeteoWeatherProvider.prototype.fetch = async function () {
  const config = this.config;
  const url = new URL(config.openMeteoForecast);
  url.searchParams.set("latitude", String(config.city.lat));
  url.searchParams.set("longitude", String(config.city.lon));
  url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m");
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", config.timeZone);
  applyOpenMeteoWindow(url, config);

  const data = await fetchJson(url, { timeoutMs: config.timeouts.fetchMs });
  if (!data.daily?.time?.length) {
    throw new Error("Weather response was missing daily forecast.");
  }
  return {
    current: data.current || null,
    daily: data.daily,
    source: "Open-Meteo",
    fetchedAt: new Date(),
  };
};

export function NwsWeatherProvider(config) {
  this.config = config || CONFIG;
}

NwsWeatherProvider.prototype.fetch = async function () {
  const config = this.config;
  const headers = config.nwsHeaders();
  const timeoutMs = config.timeouts.fetchMs;
  const points = await fetchJson(config.nwsPoints(config.city.lat, config.city.lon), {
    timeoutMs,
    headers,
  });
  const forecastUrl = points.properties?.forecast;
  const hourlyUrl = points.properties?.forecastHourly;
  if (!forecastUrl) throw new Error("NWS did not return a city forecast.");

  const [forecast, hourly] = await Promise.all([
    fetchJson(forecastUrl, { timeoutMs, headers }),
    hourlyUrl
      ? fetchJson(hourlyUrl, { timeoutMs, headers }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const periods = forecast.properties?.periods || [];
  const hourlyPeriods = hourly?.properties?.periods || [];
  const daily = applyHourlyExtrema(
    dailyFromNwsForecast(periods, config.timeZone),
    hourlyPeriods,
    config.timeZone
  );
  if (!daily.time.length) throw new Error("NWS forecast had no periods.");

  const city = nwsCityName(points, config.city.name);
  return {
    current: currentFromNwsPeriod(pickHourlyCurrent(hourlyPeriods, new Date())) || currentFromNwsPeriod(periods[0]),
    daily,
    source: `National Weather Service · ${city}`,
    fetchedAt: new Date(),
  };
};

export function weatherProviders(config) {
  const cfg = config || CONFIG;
  return [new NwsWeatherProvider(cfg), new OpenMeteoWeatherProvider(cfg)];
}

function dailyRowMap(daily) {
  const map = {};
  if (!daily?.time) return map;
  daily.time.forEach((dayKey, i) => {
    map[dayKey] = {
      temperature_2m_max: daily.temperature_2m_max?.[i] ?? null,
      temperature_2m_min: daily.temperature_2m_min?.[i] ?? null,
      weather_code: daily.weather_code?.[i] ?? null,
      wx_label: daily.wx_label?.[i] || "",
      wind_speed_10m_max: daily.wind_speed_10m_max?.[i] ?? null,
      wind_direction_10m_dominant: daily.wind_direction_10m_dominant?.[i] ?? null,
    };
  });
  return map;
}

function hasHighOrLow(row) {
  return row && (row.temperature_2m_max != null || row.temperature_2m_min != null);
}

export function mergeWeatherPayloads(primary, fallback) {
  if (!primary) return fallback || null;
  if (!fallback) return primary;
  const preferred = dailyRowMap(primary.daily);
  const extra = dailyRowMap(fallback.daily);
  const keys = [...new Set([...Object.keys(preferred), ...Object.keys(extra)])].sort();
  const daily = {
    time: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    weather_code: [],
    wx_label: [],
    wind_speed_10m_max: [],
    wind_direction_10m_dominant: [],
  };
  for (const key of keys) {
    const row = hasHighOrLow(preferred[key]) ? preferred[key] : extra[key] || preferred[key];
    if (!row) continue;
    daily.time.push(key);
    daily.temperature_2m_max.push(row.temperature_2m_max);
    daily.temperature_2m_min.push(row.temperature_2m_min);
    daily.weather_code.push(row.weather_code);
    daily.wx_label.push(row.wx_label || "");
    daily.wind_speed_10m_max.push(row.wind_speed_10m_max);
    daily.wind_direction_10m_dominant.push(row.wind_direction_10m_dominant);
  }
  return {
    current: primary.current || fallback.current,
    daily,
    source: primary.source,
    fetchedAt: primary.fetchedAt || fallback.fetchedAt,
  };
}

export async function fetchCityWeather(config, opts) {
  const options = opts || {};
  const results = [];
  for (const provider of weatherProviders(config)) {
    try {
      const result = await provider.fetch();
      if (isUsableProviderResult(result)) results.push(result);
    } catch (error) {
      if (options.log) options.log(error);
      else console.error(error);
    }
  }
  if (!results.length) {
    throw new Error(options.emptyError || "No weather forecast was available for this location.");
  }
  return results.slice(1).reduce((merged, next) => mergeWeatherPayloads(merged, next), results[0]);
}
