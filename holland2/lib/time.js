import { CONFIG } from "../config.js";

export function detroitDayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || CONFIG.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date || new Date());
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(value) {
  return typeof value === "string" && DAY_KEY_RE.test(value);
}

function utcFromDayKey(dayKey) {
  const match = DAY_KEY_RE.exec(dayKey);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function eachDayKey(startKey, endKey) {
  const start = utcFromDayKey(startKey);
  const end = utcFromDayKey(endKey);
  if (start == null || end == null || start > end) return [];
  const keys = [];
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    keys.push(`${y}-${m}-${day}`);
  }
  return keys;
}

export function pastDaysCount(firstOpenDay, todayKey, max) {
  const start = utcFromDayKey(firstOpenDay);
  const today = utcFromDayKey(todayKey);
  if (start == null || today == null) return 0;
  const days = Math.round((today - start) / 86400000);
  const cap = max == null ? 92 : max;
  return Math.max(0, Math.min(cap, days));
}

export function forecastWindow(config, now) {
  const cfg = config || CONFIG;
  const todayKey = detroitDayKey(now, cfg.timeZone);
  return {
    todayKey,
    pastDays: pastDaysCount(cfg.firstOpenDay, todayKey, 92),
    forecastDays: cfg.forecastDays,
    windowKeys: eachDayKey(cfg.firstOpenDay, cfg.lastOpenDay),
  };
}

export function applyOpenMeteoWindow(url, config, now) {
  const window = forecastWindow(config, now);
  url.searchParams.set("forecast_days", String(window.forecastDays));
  if (window.pastDays > 0) {
    url.searchParams.set("past_days", String(window.pastDays));
  }
  return window;
}

export function isAfterLastOpenDay(date, lastOpenDay, timeZone) {
  return detroitDayKey(date, timeZone) > lastOpenDay;
}

export function resolveClosed(opts) {
  const params = opts.searchParams;
  if (params && params.get(opts.previewParam) === "1") return true;
  return isAfterLastOpenDay(opts.now, opts.lastOpenDay, opts.timeZone);
}

export function formatDayLabel(dayKey, opts) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 16));
  const timeZone = (opts && opts.timeZone) || CONFIG.timeZone;
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(noon);
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(noon);
  return {
    kicker: opts && opts.isCurrent ? "Today" : weekday,
    date: monthDay,
  };
}

export function formatClock(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || CONFIG.timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function formatCommentTime(date, timeZone) {
  const d = date && typeof date.toDate === "function" ? date.toDate() : date instanceof Date ? date : null;
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || CONFIG.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function durationToMs(duration) {
  if (!duration) return 0;
  const days = String(duration).match(/(\d+)D/);
  const hours = String(duration).match(/(\d+)H/);
  const minutes = String(duration).match(/(\d+)M/);
  return (
    (days ? Number(days[1]) * 86400000 : 0) +
    (hours ? Number(hours[1]) * 3600000 : 0) +
    (minutes ? Number(minutes[1]) * 60000 : 0)
  );
}
