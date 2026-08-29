function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

export function conditions(fields) {
  const src = fields || {};
  return {
    weatherCode: asNumber(src.weatherCode),
    tempF: asNumber(src.tempF),
    highF: asNumber(src.highF),
    lowF: asNumber(src.lowF),
    windMph: asNumber(src.windMph),
    windDirDeg: asNumber(src.windDirDeg),
  };
}

export function waveObservation(fields) {
  const src = fields || {};
  return {
    heightM: asNumber(src.heightM),
    periodS: asNumber(src.periodS),
    directionDeg: asNumber(src.directionDeg),
    source: src.source || null,
  };
}

export function day(fields) {
  const src = fields || {};
  return {
    dayKey: src.dayKey,
    isCurrent: Boolean(src.isCurrent),
    forecast: src.forecast,
    observations: src.observations || null,
    waves: src.waves || { now: null, max: null },
    weatherSource: src.weatherSource || null,
    waveSource: src.waveSource || null,
  };
}

export function commentFromDoc(data) {
  const src = data || {};
  return {
    nickname: src.nickname || "",
    text: src.text || "",
    createdAt: src.createdAt || null,
    dayKey: src.dayKey || "",
  };
}

export function photoFromDoc(data) {
  const src = data || {};
  return {
    dayKey: src.dayKey || "",
    url: src.url || "",
    path: src.path || "",
    createdAt: src.createdAt || null,
  };
}

export const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function compassFromDegrees(deg) {
  if (deg == null || Number.isNaN(Number(deg))) return "";
  const idx = Math.round(Number(deg) / 22.5) % 16;
  return COMPASS[idx];
}

export function formatTemp(f) {
  return `${Math.round(f)}°`;
}

export function formatWaveFt(meters) {
  if (meters == null || Number.isNaN(Number(meters))) return "—";
  const feet = Number(meters) * 3.28084;
  if (feet < 0.15) return "Calm";
  return `${feet.toFixed(1)} ft`;
}

export function tempHeadline(dayModel) {
  const value = dayModel.observations?.tempF ?? dayModel.forecast?.highF;
  if (value == null) return "—";
  return formatTemp(value);
}

export function windHeadline(dayModel) {
  const speed = dayModel.observations?.windMph ?? dayModel.forecast?.windMph;
  const dir = dayModel.observations?.windDirDeg ?? dayModel.forecast?.windDirDeg;
  if (speed == null) return null;
  const compass = compassFromDegrees(dir);
  return compass ? `Wind ${Math.round(speed)} mph ${compass}` : `Wind ${Math.round(speed)} mph`;
}

export function waveHeadline(dayModel) {
  const waves = dayModel.waves || {};
  const now = waves.now;
  const max = waves.max;
  const compass = compassFromDegrees(max?.directionDeg ?? now?.directionDeg);
  let bits;
  if (now) {
    bits = [`Now ${formatWaveFt(now.heightM)}`];
    if (max) bits.push(`max ${formatWaveFt(max.heightM)}`);
  } else if (max) {
    bits = [`Waves ${formatWaveFt(max.heightM)}`];
  } else {
    bits = [`Waves —`];
  }
  if (compass) bits.push(compass);
  return bits.join(" · ");
}
