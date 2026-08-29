import { CONFIG } from "../config.js";
import { detroitDayKey } from "../lib/time.js";
import { conditions, day } from "./models.js";

export function buildDays(weatherPayload, wavePayload, opts) {
  const options = opts || {};
  const now = options.now || new Date();
  const timeZone = options.timeZone || CONFIG.timeZone;
  const dates =
    weatherPayload?.daily?.time?.slice() ||
    Object.keys(wavePayload?.dailyByDate || {}).sort();

  return dates.map((dayKey, i) => {
    const isCurrent = dayKey === detroitDayKey(now, timeZone);
    const daily = weatherPayload?.daily;
    const forecast = conditions({
      weatherCode: daily?.weather_code?.[i],
      highF: daily?.temperature_2m_max?.[i],
      lowF: daily?.temperature_2m_min?.[i],
      windMph: daily?.wind_speed_10m_max?.[i],
      windDirDeg: daily?.wind_direction_10m_dominant?.[i],
    });

    const current = weatherPayload?.current;
    const observations =
      isCurrent && current
        ? conditions({
            weatherCode: current.weather_code,
            tempF: current.temperature_2m,
            windMph: current.wind_speed_10m,
            windDirDeg: current.wind_direction_10m,
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
