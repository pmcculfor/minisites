import { CONFIG } from "../config.js";
import { fetchJson } from "../lib/http.js";
import { applyOpenMeteoWindow } from "../lib/time.js";

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
