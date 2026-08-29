export function classify(dx, dy, thresholdPx) {
  if (Math.abs(dx) < thresholdPx && Math.abs(dy) < thresholdPx) return "undecided";
  return Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
}

export function createScrollCoordinator(opts) {
  const scroller = opts.scroller;
  const getPageScroller = opts.getPageScroller || (() => window);
  const thresholdPx = opts.thresholdPx;
  const isExemptTarget = opts.isExemptTarget || (() => false);

  let bound = false;
  let touch = null;

  function page() {
    return getPageScroller();
  }

  function onTouchStart(event) {
    if (event.touches.length !== 1) return;
    if (isExemptTarget(event.target)) return;
    const t = event.touches[0];
    touch = {
      id: t.identifier,
      x: t.clientX,
      y: t.clientY,
      lastY: t.clientY,
      axis: "undecided",
    };
  }

  function onTouchMove(event) {
    if (event.touches.length !== 1) return;
    if (isExemptTarget(event.target)) return;
    if (!touch) return;

    const t = event.touches[0];
    if (touch.axis === "x") return;
    if (touch.axis === "y") {
      event.preventDefault();
      page().scrollBy(0, touch.lastY - t.clientY);
      touch.lastY = t.clientY;
      return;
    }

    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    const axis = classify(dx, dy, thresholdPx);
    if (axis === "undecided") return;
    touch.axis = axis;
    if (axis === "y") {
      event.preventDefault();
      page().scrollBy(0, touch.lastY - t.clientY);
      touch.lastY = t.clientY;
    }
  }

  function onTouchEnd() {
    touch = null;
  }

  function onWheel(event) {
    const axis = classify(event.deltaX, event.deltaY, 0);
    if (axis === "y" && event.deltaY !== 0) {
      event.preventDefault();
      page().scrollBy(0, event.deltaY);
    }
  }

  return {
    bind: function () {
      if (bound) return;
      bound = true;
      scroller.addEventListener("touchstart", onTouchStart, { passive: true });
      scroller.addEventListener("touchmove", onTouchMove, { passive: false });
      scroller.addEventListener("touchend", onTouchEnd, { passive: true });
      scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
      scroller.addEventListener("wheel", onWheel, { passive: false });
    },
    destroy: function () {
      if (!bound) return;
      bound = false;
      touch = null;
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      scroller.removeEventListener("wheel", onWheel);
    },
  };
}
