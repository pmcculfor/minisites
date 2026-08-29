import { CONFIG } from "../config.js";
import { createScrollCoordinator } from "./ScrollCoordinator.js";

const KEYBOARD_GUARD = "input, textarea, select, [contenteditable]";

export class DayCarousel {
  constructor(props) {
    this._scroller = props.scroller;
    this._prevBtn = props.prevBtn;
    this._nextBtn = props.nextBtn;
    this._tiles = [];
    this._dragging = false;
    this._startX = 0;
    this._startScroll = 0;

    this._coordinator = createScrollCoordinator({
      scroller: this._scroller,
      getPageScroller: () => window,
      thresholdPx: CONFIG.scroll.axisThresholdPx,
      isExemptTarget: (el) => Boolean(el.closest && el.closest(CONFIG.scroll.touchExemptSelector)),
    });

    this._onPrev = () => this.scrollByTiles(-1);
    this._onNext = () => this.scrollByTiles(1);
    this._onScroll = () => this._syncNav();
    this._onKeyDown = (event) => this._handleKey(event);
    this._onPointerDown = (event) => this._handlePointerDown(event);
    this._onPointerMove = (event) => this._handlePointerMove(event);
    this._onPointerUp = () => this._endDrag();
    this._onResize = () => this._syncNav();

    this._prevBtn.addEventListener("click", this._onPrev);
    this._nextBtn.addEventListener("click", this._onNext);
    this._scroller.addEventListener("scroll", this._onScroll, { passive: true });
    this._scroller.addEventListener("keydown", this._onKeyDown);
    this._scroller.addEventListener("pointerdown", this._onPointerDown);
    this._scroller.addEventListener("pointermove", this._onPointerMove);
    this._scroller.addEventListener("pointerup", this._onPointerUp);
    this._scroller.addEventListener("pointercancel", this._onPointerUp);
    window.addEventListener("resize", this._onResize);

    this._coordinator.bind();
    this._syncNav();
  }

  setTiles(tiles) {
    this._tiles = tiles || [];
    this._scroller.replaceChildren(...this._tiles.map((tile) => tile.element));
    this._coordinator.bind();
    this._syncNav();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => this._syncNav());
    }
  }

  scrollToDayKey(dayKey, opts) {
    const tile = this._scroller.querySelector(`.forecast-tile[data-day="${dayKey}"]`);
    if (!tile) {
      this._syncNav();
      return;
    }
    const scrollerBox = this._scroller.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    const left = this._scroller.scrollLeft + (tileBox.left - scrollerBox.left);
    const behavior = (opts && opts.behavior) || "auto";
    this._scroller.scrollTo({ left, behavior });
    this._syncNav();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => this._syncNav());
    }
  }

  scrollByTiles(deltaIndex) {
    this._scroller.scrollBy({
      left: deltaIndex * this._tileStep(),
      behavior: this._behavior(),
    });
  }

  destroy() {
    this._prevBtn.removeEventListener("click", this._onPrev);
    this._nextBtn.removeEventListener("click", this._onNext);
    this._scroller.removeEventListener("scroll", this._onScroll);
    this._scroller.removeEventListener("keydown", this._onKeyDown);
    this._scroller.removeEventListener("pointerdown", this._onPointerDown);
    this._scroller.removeEventListener("pointermove", this._onPointerMove);
    this._scroller.removeEventListener("pointerup", this._onPointerUp);
    this._scroller.removeEventListener("pointercancel", this._onPointerUp);
    window.removeEventListener("resize", this._onResize);
    if (this._coordinator) this._coordinator.destroy();
    this._tiles.forEach((tile) => tile.destroy && tile.destroy());
    this._tiles = [];
  }

  _behavior() {
    if (typeof window !== "undefined" && window.matchMedia) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "auto";
    }
    return CONFIG.scroll.snapBehavior;
  }

  _tileStep() {
    const tile = this._scroller.querySelector(".forecast-tile");
    if (!tile) return this._scroller.clientWidth;
    const styles = getComputedStyle(this._scroller);
    const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0;
    return tile.getBoundingClientRect().width + gap;
  }

  _syncNav() {
    const max = Math.max(0, this._scroller.scrollWidth - this._scroller.clientWidth - 2);
    this._prevBtn.disabled = this._scroller.scrollLeft <= 2;
    this._nextBtn.disabled = this._scroller.scrollLeft >= max;
  }

  _handleKey(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.target && event.target.closest && event.target.closest(KEYBOARD_GUARD)) return;
    event.preventDefault();
    this.scrollByTiles(event.key === "ArrowLeft" ? -1 : 1);
  }

  _handlePointerDown(event) {
    if (event.pointerType === "touch") return;
    if (!event.target.closest(".tile-sky")) return;
    this._dragging = true;
    this._startX = event.clientX;
    this._startScroll = this._scroller.scrollLeft;
    this._scroller.setPointerCapture(event.pointerId);
  }

  _handlePointerMove(event) {
    if (!this._dragging) return;
    this._scroller.scrollLeft = this._startScroll - (event.clientX - this._startX);
  }

  _endDrag() {
    if (!this._dragging) return;
    this._dragging = false;
    const step = this._tileStep();
    const snapped = Math.round(this._scroller.scrollLeft / step) * step;
    this._scroller.scrollTo({ left: snapped, behavior: this._behavior() });
  }
}
