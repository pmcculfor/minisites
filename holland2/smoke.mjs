import { detroitDayKey, resolveClosed, formatDayLabel, eachDayKey, pastDaysCount, forecastWindow } from "./lib/time.js";
import { skinForCode } from "./domain/weather-skins.js";
import { buildDays } from "./domain/day-builder.js";
import { isUsableWave, runProviderChain } from "./data/waves.js";
import {
  formatWaveFt,
  waveHeadline,
  windHeadline,
  conditions,
  day,
  waveObservation,
} from "./domain/models.js";
import { groupBy } from "./lib/group.js";
import { isSafeImageSrc } from "./lib/safe-url.js";
import { classify } from "./ui/ScrollCoordinator.js";
import { ERRORS, mapPhotoError } from "./ui/errors.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const edtNoon = new Date("2026-07-04T16:00:00Z");
assert(detroitDayKey(edtNoon, "America/Detroit") === "2026-07-04", "detroitDayKey EDT");

const estNoon = new Date("2026-01-15T17:00:00Z");
assert(detroitDayKey(estNoon, "America/Detroit") === "2026-01-15", "detroitDayKey EST");

assert(
  resolveClosed({
    now: new Date("2026-09-03T20:00:00Z"),
    searchParams: new URLSearchParams(""),
    lastOpenDay: "2026-09-03",
    previewParam: "previewClosed",
    timeZone: "America/Detroit",
  }) === false,
  "still open on last day"
);

assert(
  resolveClosed({
    now: new Date("2026-09-04T08:00:00Z"),
    searchParams: new URLSearchParams(""),
    lastOpenDay: "2026-09-03",
    previewParam: "previewClosed",
    timeZone: "America/Detroit",
  }) === true,
  "closed the day after"
);

assert(
  resolveClosed({
    now: new Date("2026-09-01T12:00:00Z"),
    searchParams: new URLSearchParams("previewClosed=1"),
    lastOpenDay: "2026-09-03",
    previewParam: "previewClosed",
    timeZone: "America/Detroit",
  }) === true,
  "previewClosed forces closed"
);

assert(skinForCode(0).className === "wx-clear" && skinForCode(0).label === "Clear", "skin 0");
assert(skinForCode(63).className === "wx-rain" && skinForCode(63).dark === true, "skin 63");
assert(skinForCode(95).className === "wx-thunder" && skinForCode(95).label === "Thunderstorm", "skin 95");
assert(skinForCode(1234).label === "—" && skinForCode(1234).className === "wx-overcast", "unknown skin");
assert(skinForCode(48).label === "Icy fog", "label 48");
assert(skinForCode(77).label === "Snow grains", "label 77");
assert(skinForCode(80).label === "Rain showers", "label 80");
assert(skinForCode(96).label === "Thunderstorm with hail", "label 96");
assert(skinForCode(99).label === "Thunderstorm with hail", "label 99");

assert(isUsableWave(0, 0) === false, "usable 0,0");
assert(isUsableWave(1.2, 4) === true, "usable 1.2,4");
assert(isUsableWave(0, 4) === true, "usable 0,4");
assert(isUsableWave(null, 1) === false, "usable null,1");
assert(isUsableWave(null, 4) === false, "usable null,4");

const label = formatDayLabel("2026-09-03", { isCurrent: false, timeZone: "America/Detroit" });
assert(label.date === "Sep 3", `formatDayLabel date got ${label.date}`);
assert(label.kicker === "Thu", `formatDayLabel kicker got ${label.kicker}`);
const todayLabel = formatDayLabel("2026-09-03", { isCurrent: true, timeZone: "America/Detroit" });
assert(todayLabel.kicker === "Today", "formatDayLabel today");
const utcMidnight = new Date("2026-09-03");
const trapDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Detroit",
  month: "short",
  day: "numeric",
}).format(utcMidnight);
assert(
  trapDate !== label.date,
  `date-only UTC midnight trap: new Date("2026-09-03") formats as ${trapDate}, formatDayLabel is ${label.date}`
);

assert(
  mapPhotoError({ message: "file-too-large" }) === ERRORS.photoFileTooLarge,
  "file-too-large maps to photoFileTooLarge"
);

assert(formatWaveFt(null) === "—", "formatWaveFt null");
assert(formatWaveFt(0) === "Calm", "formatWaveFt calm");
assert(formatWaveFt(0.5) === "1.6 ft", "formatWaveFt decimal");

const currentDay = day({
  dayKey: "2026-08-29",
  isCurrent: true,
  forecast: conditions({ highF: 80, lowF: 60, windMph: 10, windDirDeg: 270, weatherCode: 2 }),
  observations: conditions({ tempF: 72, weatherCode: 61, windMph: 8, windDirDeg: 90 }),
  waves: {
    now: waveObservation({ heightM: 0.4, directionDeg: 90 }),
    max: waveObservation({ heightM: 1.2, directionDeg: 270 }),
  },
});
assert(waveHeadline(currentDay) === "Now 1.3 ft · max 3.9 ft · W", `waveHeadline daily compass ${waveHeadline(currentDay)}`);

const nowOnly = day({
  dayKey: "2026-08-29",
  isCurrent: true,
  forecast: conditions({}),
  observations: null,
  waves: { now: waveObservation({ heightM: 0.4, directionDeg: 90 }), max: null },
});
assert(waveHeadline(nowOnly) === "Now 1.3 ft · E", `waveHeadline no max ${waveHeadline(nowOnly)}`);

const none = day({
  dayKey: "2026-08-29",
  forecast: conditions({}),
  waves: { now: null, max: null },
});
assert(waveHeadline(none) === "Waves —", "waveHeadline empty");

assert(windHeadline(none) === null, "windHeadline null");
assert(windHeadline(currentDay) === "Wind 8 mph E", `windHeadline ${windHeadline(currentDay)}`);

const weatherOnlyDays = buildDays(
  {
    source: "Open-Meteo",
    current: { temperature_2m: 70, weather_code: 0, wind_speed_10m: 5, wind_direction_10m: 180 },
    daily: {
      time: ["2026-08-29", "2026-08-30"],
      weather_code: [0, 3],
      temperature_2m_max: [80, 77],
      temperature_2m_min: [60, 58],
      wind_speed_10m_max: [10, 12],
      wind_direction_10m_dominant: [180, 90],
    },
  },
  null,
  { now: new Date("2026-08-29T16:00:00Z"), timeZone: "America/Detroit", forecastDays: 7 }
);
assert(weatherOnlyDays.length === 2, "weather-only does not throw and keeps 2 days");
assert(weatherOnlyDays[0].isCurrent === true, "today flagged");
assert(weatherOnlyDays[0].observations?.tempF === 70, "observations on current");
assert(weatherOnlyDays[1].observations === null, "observations null on other days");
assert(weatherOnlyDays[0].waves.now === null && weatherOnlyDays[0].waves.max === null, "waves optional");

assert(eachDayKey("2026-08-22", "2026-08-24").join(",") === "2026-08-22,2026-08-23,2026-08-24", "eachDayKey inclusive");
assert(eachDayKey("2026-08-24", "2026-08-22").length === 0, "eachDayKey reversed empty");
assert(pastDaysCount("2026-08-22", "2026-08-29") === 7, "pastDaysCount 7");
assert(pastDaysCount("2026-08-29", "2026-08-29") === 0, "pastDaysCount today");
assert(pastDaysCount("2026-09-01", "2026-08-29") === 0, "pastDaysCount future start");
assert(pastDaysCount("2026-08-22", "2026-08-29", 3) === 3, "pastDaysCount cap");

const ranged = buildDays(
  {
    source: "Open-Meteo",
    current: { temperature_2m: 70, weather_code: 0, wind_speed_10m: 5, wind_direction_10m: 180 },
    daily: {
      time: ["2026-08-29", "2026-08-30"],
      weather_code: [0, 3],
      temperature_2m_max: [80, 77],
      temperature_2m_min: [60, 58],
      wind_speed_10m_max: [10, 12],
      wind_direction_10m_dominant: [180, 90],
    },
  },
  null,
  {
    now: new Date("2026-08-29T16:00:00Z"),
    timeZone: "America/Detroit",
    windowKeys: eachDayKey("2026-08-28", "2026-08-30"),
  }
);
assert(ranged.map((d) => d.dayKey).join(",") === "2026-08-28,2026-08-29,2026-08-30", "window union dates");
assert(ranged[0].forecast.highF == null, "past day without weather payload is empty forecast, not index-shifted");
assert(ranged[1].forecast.highF === 80, "today forecast keyed by dayKey");
assert(ranged[2].forecast.highF === 77, "next day forecast keyed by dayKey");
assert(ranged[0].isCurrent === false && ranged[1].isCurrent === true, "current flag on today in window");

const windowOnly = buildDays(null, null, {
  now: new Date("2026-08-29T16:00:00Z"),
  timeZone: "America/Detroit",
  windowKeys: eachDayKey("2026-08-28", "2026-08-29"),
});
assert(windowOnly.length === 2, "trip window tiles exist without weather or waves");

const fw = forecastWindow(
  { firstOpenDay: "2026-08-22", lastOpenDay: "2026-09-03", forecastDays: 7, timeZone: "America/Detroit" },
  new Date("2026-08-29T16:00:00Z")
);
assert(fw.pastDays === 7, "forecastWindow pastDays");
assert(fw.windowKeys[0] === "2026-08-22" && fw.windowKeys.at(-1) === "2026-09-03", "forecastWindow keys");

const waveOnly = buildDays(
  null,
  {
    source: "National Weather Service",
    current: waveObservation({ heightM: 1 }),
    dailyByDate: {
      "2026-08-29": waveObservation({ heightM: 1 }),
      "2026-08-30": waveObservation({ heightM: 2 }),
      "2026-08-31": waveObservation({ heightM: 3 }),
      "2026-09-01": waveObservation({ heightM: 4 }),
      "2026-09-02": waveObservation({ heightM: 5 }),
      "2026-09-03": waveObservation({ heightM: 6 }),
      "2026-09-04": waveObservation({ heightM: 7 }),
      "2026-09-05": waveObservation({ heightM: 8 }),
    },
  },
  { now: new Date("2026-08-29T16:00:00Z"), timeZone: "America/Detroit", forecastDays: 7 }
);
assert(waveOnly.length === 8, `wave-only dates are not sliced, got ${waveOnly.length}`);
assert(waveOnly[0].waves.now?.heightM === 1, "waves.now only on current");
assert(waveOnly[1].waves.now === null, "waves.now null on other days");

const grouped = groupBy(
  [
    { dayKey: "a", n: 1 },
    { dayKey: "b", n: 2 },
    { dayKey: "a", n: 3 },
  ],
  (item) => item.dayKey
);
assert(grouped.get("a").length === 2 && grouped.get("b").length === 1, "groupBy");

assert(isSafeImageSrc("javascript:alert(1)") === false, "js url");
assert(isSafeImageSrc("x".repeat(12)) === false, "random short");
assert(isSafeImageSrc("x".repeat(900001)) === false, "oversized");
assert(isSafeImageSrc("data:image/jpeg;base64,abcDEF123+/=") === true, "jpeg data url");
assert(
  isSafeImageSrc("https://firebasestorage.googleapis.com/v0/b/x/o/y") === true,
  "storage https"
);

assert(classify(1, 1, 8) === "undecided", "classify below threshold");
assert(classify(0, 10, 8) === "y", "classify y");
assert(classify(10, 0, 8) === "x", "classify x");
assert(classify(3, 3, 0) === "y", "wheel equal prefers y");
assert(classify(10, 0, 0) === "x", "wheel horizontal");
assert(classify(0, 0, 0) === "y", "zero deltas classify y; coordinator must not steal when deltaY===0");

let secondCalled = false;
await runProviderChain(
  [
    { fetch: async () => { throw new Error("boom"); } },
    {
      fetch: async () => {
        secondCalled = true;
        return { current: { heightM: 1 }, dailyByDate: { "2026-08-29": { heightM: 1 } }, source: "test" };
      },
    },
  ],
  { log: () => {} }
);
assert(secondCalled, "provider throw continues chain");

console.log("holland2 smoke: all assertions passed");
