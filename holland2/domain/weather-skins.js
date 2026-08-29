export const WEATHER_SKINS = [
  { codes: [0], className: "wx-clear", label: "Clear", dark: false },
  { codes: [1], className: "wx-mostly", label: "Mostly clear", dark: false },
  { codes: [2], className: "wx-partly", label: "Partly cloudy", dark: false },
  { codes: [3], className: "wx-overcast", label: "Overcast", dark: false },
  { codes: [45], className: "wx-fog", label: "Fog", dark: false },
  { codes: [48], className: "wx-fog", label: "Icy fog", dark: false },
  { codes: [51], className: "wx-drizzle", label: "Light drizzle", dark: false },
  { codes: [53], className: "wx-drizzle", label: "Drizzle", dark: false },
  { codes: [55], className: "wx-drizzle", label: "Heavy drizzle", dark: false },
  { codes: [56], className: "wx-drizzle", label: "Freezing drizzle", dark: false },
  { codes: [57], className: "wx-drizzle", label: "Freezing drizzle", dark: false },
  { codes: [61], className: "wx-rain", label: "Light rain", dark: true },
  { codes: [63], className: "wx-rain", label: "Rain", dark: true },
  { codes: [65], className: "wx-heavy", label: "Heavy rain", dark: true },
  { codes: [66], className: "wx-rain", label: "Freezing rain", dark: true },
  { codes: [67], className: "wx-rain", label: "Freezing rain", dark: true },
  { codes: [71], className: "wx-snow", label: "Light snow", dark: false },
  { codes: [73], className: "wx-snow", label: "Snow", dark: false },
  { codes: [75], className: "wx-snow", label: "Heavy snow", dark: false },
  { codes: [77], className: "wx-snow", label: "Snow grains", dark: false },
  { codes: [80], className: "wx-showers", label: "Rain showers", dark: true },
  { codes: [81], className: "wx-showers", label: "Rain showers", dark: true },
  { codes: [82], className: "wx-heavy", label: "Heavy showers", dark: true },
  { codes: [85], className: "wx-snow", label: "Snow showers", dark: false },
  { codes: [86], className: "wx-snow", label: "Heavy snow showers", dark: false },
  { codes: [95], className: "wx-thunder", label: "Thunderstorm", dark: true },
  { codes: [96], className: "wx-thunder", label: "Thunderstorm with hail", dark: true },
  { codes: [99], className: "wx-thunder", label: "Thunderstorm with hail", dark: true },
];

export const FALLBACK_SKIN = { className: "wx-overcast", label: "—", dark: false };

const SKIN_BY_CODE = new Map();
for (const skin of WEATHER_SKINS) {
  for (const code of skin.codes) {
    SKIN_BY_CODE.set(code, skin);
  }
}

export function skinForCode(code) {
  if (code == null || code === "") return FALLBACK_SKIN;
  const n = Number(code);
  return SKIN_BY_CODE.get(n) || FALLBACK_SKIN;
}
