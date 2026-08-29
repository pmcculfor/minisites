export const CONFIG = {
  timeZone: "America/Detroit",
  firstOpenDay: "2026-08-27", // inclusive; first carousel day (past notes/photos stay visible)
  lastOpenDay: "2026-09-03", // inclusive; closed when detroitDayKey() > this
  previewClosedParam: "previewClosed",
  forecastDays: 7,
  city: { lat: 42.7875, lon: -86.1089, name: "Holland, MI" },
  wavePoint: { lat: 42.9, lon: -86.5 },
  nwsPoint: { lat: 42.9, lon: -86.27 },
  openMeteoForecast: "https://api.open-meteo.com/v1/forecast",
  openMeteoMarine: "https://marine-api.open-meteo.com/v1/marine",
  nwsPoints: function (lat, lon) {
    return "https://api.weather.gov/points/" + lat + "," + lon;
  },
  nwsHeaders: function () {
    // Browser fetch cannot set User-Agent, and Accept: application/geo+json
    // is not a CORS-safelisted value — both force a preflight that weather.gov
    // often rejects, so the page would silently fall back to Open-Meteo.
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      return {};
    }
    return {
      Accept: "application/geo+json",
      "User-Agent": "holland2 (https://pmcculfor.github.io/minisites/holland2/; Holland MI weather)",
    };
  },
  collections: { comments: "comments", photos: "photos" },
  limits: {
    nickname: 40,
    commentText: 500,
    photoUrlChars: 900000,
    photoPathChars: 400,
    sourceFileBytes: 20 * 1024 * 1024,
    inlineJpegBytes: 180 * 1024,
    commentsQuery: 200,
    photosQuery: 60,
  },
  timeouts: {
    fetchMs: 12000,
    uploadMs: 45000,
  },
  rateLimit: {
    commentMs: 8000,
    photoMs: 4000,
  },
  image: {
    mimeOut: "image/jpeg",
    ladder: [
      { maxSide: 1024, quality: 0.7 },
      { maxSide: 960, quality: 0.56 },
      { maxSide: 800, quality: 0.48 },
      { maxSide: 640, quality: 0.4 },
    ],
    base64Chunk: 0x8000,
  },
  scroll: {
    axisThresholdPx: 8,
    snapBehavior: "smooth",
    touchExemptSelector: "input, textarea, select, button, a, label",
  },
  firebaseCdnVersion: "11.0.2",
};
