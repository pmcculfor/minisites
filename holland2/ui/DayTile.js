import { CONFIG } from "../config.js";
import { el } from "../lib/dom.js";
import { formatDayLabel } from "../lib/time.js";
import {
  formatTemp,
  tempHeadline,
  waveHeadline,
  windHeadline,
} from "../domain/models.js";
import { skinForCode } from "../domain/weather-skins.js";
import { Guestbook } from "./Guestbook.js";
import { PhotoStrip } from "./PhotoStrip.js";

export class DayTile {
  constructor(props) {
    this.day = props.day;
    this.dayKey = props.day.dayKey;
    this._guestbook = new Guestbook({
      dayKey: this.dayKey,
      store: null,
      rateLimiter: props.rateLimiters.comment,
    });
    this._photos = new PhotoStrip({
      dayKey: this.dayKey,
      store: null,
      pipeline: props.pipeline,
      rateLimiter: props.rateLimiters.photo,
    });
    this._guestbook.element.append(this._photos.element);
    this._root = this._render(props.day);
  }

  get element() {
    return this._root;
  }

  attachStore(store) {
    this._guestbook.attachStore(store);
    this._photos.attachStore(store);
  }

  setComments(items) {
    this._guestbook.setItems(items);
  }

  setPhotos(items) {
    this._photos.setItems(items);
  }

  setFeedState(state, message) {
    this._guestbook.setFeedState(state, message);
  }

  setListState(state, message) {
    this._photos.setListState(state, message);
  }

  destroy() {
    this._guestbook.destroy();
    this._photos.destroy();
  }

  _render(dayModel) {
    const skinCode = dayModel.observations?.weatherCode ?? dayModel.forecast?.weatherCode;
    const skin = skinForCode(skinCode);
    const labels = formatDayLabel(dayModel.dayKey, {
      isCurrent: dayModel.isCurrent,
      timeZone: CONFIG.timeZone,
    });

    const skyClass = ["tile-sky", skin.className];
    if (skin.dark) skyClass.push("wx-dark");

    const skyChildren = [
      el("div", { class: "tile-sky-fade", "aria-hidden": "true" }),
      el("p", { class: "tile-kicker", text: labels.kicker }),
      el("p", { class: "tile-date", text: labels.date }),
      el("p", { class: "tile-temp", text: tempHeadline(dayModel) }),
    ];

    const high = dayModel.forecast?.highF;
    const low = dayModel.forecast?.lowF;
    if (high != null && low != null) {
      skyChildren.push(
        el("p", { class: "tile-range", text: `H ${formatTemp(high)} / L ${formatTemp(low)}` })
      );
    }

    const wxLabel = dayModel.observations?.wxLabel || dayModel.forecast?.wxLabel || skin.label;
    skyChildren.push(el("p", { class: "tile-wx", text: wxLabel }));
    skyChildren.push(el("p", { class: "tile-waves", text: waveHeadline(dayModel) }));

    const wind = windHeadline(dayModel);
    if (wind) {
      skyChildren.push(el("p", { class: "tile-wind", text: wind }));
    }

    const tileClass = dayModel.isCurrent ? "forecast-tile is-today" : "forecast-tile";
    const tile = el("article", { class: tileClass }, [
      el("div", { class: skyClass.join(" ") }, skyChildren),
      this._guestbook.element,
    ]);
    tile.dataset.day = dayModel.dayKey;
    tile.setAttribute("aria-label", `Weather and notes for ${dayModel.dayKey}`);
    return tile;
  }
}
