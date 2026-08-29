import { CONFIG } from "../config.js";

export function detroitDayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || CONFIG.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date || new Date());
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
