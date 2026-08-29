import { CONFIG } from "../config.js";
import { fetchJson } from "../lib/http.js";
import { applyOpenMeteoWindow, detroitDayKey, durationToMs } from "../lib/time.js";
import { waveObservation } from "../domain/models.js";

export function isUsableWave(height, period) {
  if (height == null || Number.isNaN(Number(height))) return false;
  const h = Number(height);
  const p = period == null ? null : Number(period);
  if (h === 0 && (p === 0 || p == null)) return false;
  return true;
}

export function waveProviders(config) {
  return [
    new OpenMeteoMarineProvider({
      model: "ecmwf_wam025",
      point: config.wavePoint,
      config,
    }),
    new OpenMeteoMarineProvider({
      model: "ncep_gfswave025",
      point: config.wavePoint,
      config,
    }),
    new NwsWaveProvider({ point: config.nwsPoint, config }),
  ];
}

export async function runProviderChain(providers, opts) {
  const options = opts || {};
  for (const provider of providers) {
    try {
      const result = await provider.fetch();
      if (result && (Object.keys(result.dailyByDate || {}).length > 0 || result.current != null)) {
        return result;
      }
    } catch (error) {
      if (options.log) options.log(error);
      else console.error(error);
    }
  }
  throw new Error("No wave forecast was available for this location.");
}

function dailyMapFromOpenMeteo(daily, source) {
  const map = {};
  if (!daily?.time) return map;
  daily.time.forEach((dayKey, i) => {
    const height = daily.wave_height_max?.[i];
    const period = daily.wave_period_max?.[i];
    if (!isUsableWave(height, period)) return;
    map[dayKey] = waveObservation({
      heightM: Number(height),
      periodS: period == null ? null : Number(period),
      directionDeg: daily.wave_direction_dominant?.[i] ?? null,
      source,
    });
  });
  return map;
}

export function OpenMeteoMarineProvider(opts) {
  const options = opts || {};
  this.model = options.model;
  this.point = options.point;
  this.config = options.config || CONFIG;
}

OpenMeteoMarineProvider.prototype.fetch = async function () {
  const config = this.config;
  const model = this.model;
  const point = this.point || config.wavePoint;
  const source = `Open-Meteo ${model}`;
  const url = new URL(config.openMeteoMarine);
  url.searchParams.set("latitude", String(point.lat));
  url.searchParams.set("longitude", String(point.lon));
  url.searchParams.set("current", "wave_height,wave_period,wave_direction");
  url.searchParams.set("daily", "wave_height_max,wave_direction_dominant,wave_period_max");
  url.searchParams.set("timezone", config.timeZone);
  url.searchParams.set("models", model);
  applyOpenMeteoWindow(url, config);

  const data = await fetchJson(url, { timeoutMs: config.timeouts.fetchMs });
  const dailyByDate = dailyMapFromOpenMeteo(data.daily, source);
  const current = data.current || {};
  const currentUsable = isUsableWave(current.wave_height, current.wave_period)
    ? waveObservation({
        heightM: Number(current.wave_height),
        periodS: current.wave_period == null ? null : Number(current.wave_period),
        directionDeg: current.wave_direction == null ? null : Number(current.wave_direction),
        source,
      })
    : null;
  if (!Object.keys(dailyByDate).length && !currentUsable) return null;
  return {
    current: currentUsable,
    dailyByDate,
    source,
  };
};

function nwsDailyByDate(values, source, timeZone) {
  const map = {};
  for (const item of values || []) {
    if (item.value == null) continue;
    const [startIso, duration] = String(item.validTime || "").split("/");
    const start = new Date(startIso);
    const end = new Date(start.getTime() + durationToMs(duration) || 3600000);
    for (let t = start.getTime(); t < end.getTime(); t += 3600000) {
      const key = detroitDayKey(new Date(t), timeZone);
      const prev = map[key];
      if (!prev || Number(item.value) > prev.heightM) {
        map[key] = waveObservation({
          heightM: Number(item.value),
          periodS: null,
          directionDeg: null,
          source,
        });
      }
    }
  }
  return map;
}

export function NwsWaveProvider(opts) {
  const options = opts || {};
  this.point = options.point;
  this.config = options.config || CONFIG;
}

NwsWaveProvider.prototype.fetch = async function () {
  const config = this.config;
  const point = this.point || config.nwsPoint;
  const source = "National Weather Service";
  const headers = { Accept: "application/geo+json" };
  const points = await fetchJson(config.nwsPoints(point.lat, point.lon), {
    timeoutMs: config.timeouts.fetchMs,
    headers,
  });
  const gridUrl = points.properties?.forecastGridData;
  if (!gridUrl) throw new Error("NWS did not return grid data.");

  const grid = await fetchJson(gridUrl, {
    timeoutMs: config.timeouts.fetchMs,
    headers,
  });
  const dailyByDate = nwsDailyByDate(grid.properties?.waveHeight?.values, source, config.timeZone);
  if (!Object.keys(dailyByDate).length) return null;
  const today = dailyByDate[detroitDayKey()] || null;
  return {
    current: today,
    dailyByDate,
    source,
  };
};
