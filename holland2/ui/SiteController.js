import { CONFIG } from "../config.js";
import { resolveClosed, formatClock } from "../lib/time.js";
import { groupBy } from "../lib/group.js";
import { createRateLimiters } from "../lib/rate-limit.js";
import { buildDays } from "../domain/day-builder.js";
import { OpenMeteoWeatherProvider } from "../data/weather.js";
import {
  OpenMeteoMarineProvider,
  NwsWaveProvider,
  runProviderChain,
} from "../data/waves.js";
import { fileToInlineJpeg } from "../media/image-pipeline.js";
import { connectFirebase } from "../firebase/client.js";
import { createStore } from "../firebase/store.js";
import { ClosedNotice } from "./ClosedNotice.js";
import { ConditionsCard } from "./ConditionsCard.js";
import { DayCarousel } from "./DayCarousel.js";
import { DayTile } from "./DayTile.js";
import { ERRORS } from "./errors.js";

export class SiteController {
  static create(document) {
    return new SiteController(document);
  }

  constructor(document) {
    this._doc = document;
    this._phase = null;
    this._tiles = [];
    this._carousel = null;
    this._unsubComments = null;
    this._unsubPhotos = null;
    this._live = document.getElementById("live");
    this._closed = new ClosedNotice({ root: document.getElementById("closed") });
    this._conditions = new ConditionsCard({ root: document.getElementById("conditions") });
    this._rateLimiters = null;
  }

  start() {
    const closed = resolveClosed({
      now: new Date(),
      searchParams: new URLSearchParams(this._doc.location.search),
      lastOpenDay: CONFIG.lastOpenDay,
      previewParam: CONFIG.previewClosedParam,
      timeZone: CONFIG.timeZone,
    });
    if (closed) {
      this._setPhase("closed");
      return;
    }
    this._setPhase("loading");
    return this._load();
  }

  destroy() {
    this._teardownFeeds();
    if (this._carousel) {
      this._carousel.destroy();
      this._carousel = null;
    }
    this._tiles = [];
  }

  _setPhase(phase, extra) {
    this._phase = phase;
    if (phase === "closed") {
      this._closed.show();
      this._live.hidden = true;
      return;
    }
    this._closed.hide();
    this._live.hidden = false;
    if (phase === "loading" || phase === "ready" || phase === "error") {
      this._conditions.setPhase(phase, extra);
    }
  }

  async _load() {
    const weatherProvider = new OpenMeteoWeatherProvider(CONFIG);
    const waveProviders = [
      new OpenMeteoMarineProvider({
        model: "ecmwf_wam025",
        point: CONFIG.wavePoint,
        config: CONFIG,
      }),
      new OpenMeteoMarineProvider({
        model: "ncep_gfswave025",
        point: CONFIG.wavePoint,
        config: CONFIG,
      }),
      new NwsWaveProvider({ point: CONFIG.nwsPoint, config: CONFIG }),
    ];

    const [weatherResult, wavesResult] = await Promise.allSettled([
      weatherProvider.fetch(),
      runProviderChain(waveProviders),
    ]);
    const weather = weatherResult.status === "fulfilled" ? weatherResult.value : null;
    const waves = wavesResult.status === "fulfilled" ? wavesResult.value : null;
    if (weatherResult.status === "rejected") console.error(weatherResult.reason);
    if (wavesResult.status === "rejected") console.error(wavesResult.reason);

    if (!weather && !waves) {
      this._setPhase("error", { message: ERRORS.weatherBothFailed });
      return;
    }

    const days = buildDays(weather, waves, {
      now: new Date(),
      timeZone: CONFIG.timeZone,
      forecastDays: CONFIG.forecastDays,
    });
    if (!days.length) {
      this._setPhase("error", { message: ERRORS.weatherBothFailed });
      return;
    }

    this._rateLimiters = createRateLimiters(CONFIG);
    this._tiles = days.map(
      (dayModel) =>
        new DayTile({
          day: dayModel,
          pipeline: fileToInlineJpeg,
          rateLimiters: this._rateLimiters,
        })
    );

    this._carousel = new DayCarousel({
      scroller: this._doc.getElementById("forecast-scroller"),
      prevBtn: this._doc.getElementById("forecast-prev"),
      nextBtn: this._doc.getElementById("forecast-next"),
    });
    this._carousel.setTiles(this._tiles);
    this._conditions.mountCarousel(this._doc.getElementById("forecast-scroller"));

    this._setPhase("ready", { asOf: this._asOfLine(weather, waves) });
    await this._connectFeeds();
  }

  _asOfLine(weather, waves) {
    const bits = [];
    if (weather?.current?.time) {
      bits.push(`Now as of ${formatClock(new Date(weather.current.time), CONFIG.timeZone)}`);
    }
    if (weather) bits.push(`weather ${weather.source}`);
    if (waves) bits.push(`waves ${waves.source}`);
    return bits.join(" · ");
  }

  async _connectFeeds() {
    const result = await connectFirebase();
    if (!result.ok) {
      this._tiles.forEach((tile) => {
        tile.setFeedState("setup", ERRORS.firebaseUnconfigured);
        tile.setListState("setup", ERRORS.firebaseUnconfigured);
      });
      return;
    }

    const store = createStore(result.db, {
      auth: result.auth,
      config: CONFIG,
      firestore: result.firestore,
      canWrite: result.canWrite,
    });
    this._tiles.forEach((tile) => tile.attachStore(store));

    this._unsubComments = store.subscribeComments(
      (docs) => {
        const byDay = groupBy(docs, (item) => item.dayKey);
        this._tiles.forEach((tile) => tile.setComments(byDay.get(tile.dayKey) || []));
      },
      (error) => {
        console.error(error);
        this._tiles.forEach((tile) => tile.setFeedState("error", ERRORS.commentsSnapshot));
      }
    );

    this._unsubPhotos = store.subscribePhotos(
      (docs) => {
        const byDay = groupBy(docs, (item) => item.dayKey);
        this._tiles.forEach((tile) => tile.setPhotos(byDay.get(tile.dayKey) || []));
      },
      (error) => {
        console.error(error);
        this._tiles.forEach((tile) => tile.setListState("error", ERRORS.photosSnapshot));
      }
    );
  }

  _teardownFeeds() {
    if (this._unsubComments) {
      this._unsubComments();
      this._unsubComments = null;
    }
    if (this._unsubPhotos) {
      this._unsubPhotos();
      this._unsubPhotos = null;
    }
  }
}
