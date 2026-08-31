import { CONFIG } from "../config.js";
import { clipToOpenDays, detroitDayKey } from "../lib/time.js";
import { conditions, day } from "./models.js";

function forecastByDay(daily) {
  const map = {};
  if (!daily?.time) return map;
  daily.time.forEach((dayKey, i) => {
    map[dayKey] = conditions({
      weatherCode: daily.weather_code?.[i],
      highF: daily.temperature_2m_max?.[i],
      lowF: daily.temperature_2m_min?.[i],
      windMph: daily.wind_speed_10m_max?.[i],
      windDirDeg: daily.wind_direction_10m_dominant?.[i],
      wxLabel: daily.wx_label?.[i] || null,
    });
  });
  return map;
}

export function buildDays(weatherPayload, wavePayload, opts) {
  const options = opts || {};
  const now = options.now || new Date();
  const timeZone = options.timeZone || CONFIG.timeZone;
  const weatherMap = forecastByDay(weatherPayload?.daily);
  const firstOpenDay = options.firstOpenDay || CONFIG.firstOpenDay;
  const lastOpenDay = options.lastOpenDay || CONFIG.lastOpenDay;
  const dates = clipToOpenDays(
    [
      ...new Set([
        ...(options.windowKeys || []),
        ...(weatherPayload?.daily?.time || []),
        ...Object.keys(wavePayload?.dailyByDate || {}),
      ]),
    ].sort(),
    firstOpenDay,
    lastOpenDay
  );

  return dates.map((dayKey) => {
    const isCurrent = dayKey === detroitDayKey(now, timeZone);
    const forecast = weatherMap[dayKey] || conditions();

    const current = weatherPayload?.current;
    const observations =
      isCurrent && current
        ? conditions({
            weatherCode: current.weather_code,
            tempF: current.temperature_2m,
            windMph: current.wind_speed_10m,
            windDirDeg: current.wind_direction_10m,
            wxLabel: current.wx_label || null,
          })
        : null;

    const maxWave = wavePayload?.dailyByDate?.[dayKey] || null;
    const waves = {
      now: isCurrent ? wavePayload?.current ?? maxWave : null,
      max: maxWave,
    };

    return day({
      dayKey,
      isCurrent,
      forecast,
      observations,
      waves,
      weatherSource: weatherPayload?.source || null,
      waveSource: wavePayload?.source || null,
    });
  });
}
