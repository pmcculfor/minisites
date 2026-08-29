import { CONFIG } from "../config.js";
import { el, clear } from "../lib/dom.js";
import { ERRORS } from "./errors.js";
import { formatCommentTime } from "../lib/time.js";

function sanitizeNickname(value, max) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeText(value, max) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

export class Guestbook {
  constructor(props) {
    this.dayKey = props.dayKey;
    this._store = props.store || null;
    this._rateLimiter = props.rateLimiter;
    this._limits = CONFIG.limits;

    this._feed = el("div", { class: "comment-feed" }, [
      el("p", { class: "feed-loading", text: ERRORS.feedLoadingNotes }),
    ]);

    const companyId = `guestbook-company-${this.dayKey}`;
    this._honeypot = el("input", {
      class: "hp",
      type: "text",
      name: "company",
      id: companyId,
      autocomplete: "off",
      tabIndex: -1,
    });
    const hpLabel = el("label", { class: "hp", text: "Company", for: companyId });

    this._nameInput = el("input", {
      type: "text",
      name: "nickname",
      maxlength: String(this._limits.nickname),
      placeholder: "Anonymous",
      autocomplete: "nickname",
    });
    const nameLabel = el("label", { text: "Name " }, [
      el("span", { class: "optional", text: "(optional)" }),
    ]);

    this._textarea = el("textarea", {
      name: "text",
      maxlength: String(this._limits.commentText),
      rows: "3",
      placeholder: "Wind, water, beach, dinner…",
    });
    this._textarea.required = true;
    const textLabel = el("label", { text: "Comment" });

    this._countValue = el("span", { class: "js-count", text: "0" });
    const count = el("p", { class: "char-count" }, [
      this._countValue,
      document.createTextNode(`/${this._limits.commentText}`),
    ]);

    this._submit = el("button", { type: "submit", class: "comment-submit", text: "Post to this day" });
    this._status = el("p", { class: "form-status" });

    this._form = el("form", { class: "day-comment-form", novalidate: "" }, [
      hpLabel,
      this._honeypot,
      nameLabel,
      this._nameInput,
      textLabel,
      this._textarea,
      count,
      this._submit,
      this._status,
    ]);
    this._form.dataset.day = this.dayKey;

    this._root = el("div", { class: "tile-guestbook" }, [
      el("h3", { class: "guestbook-title", text: "Leaving note about this day" }),
      this._feed,
      this._form,
    ]);

    this._onInput = () => {
      this._countValue.textContent = String(this._textarea.value.length);
    };
    this._onSubmit = (event) => this._handleSubmit(event);
    this._textarea.addEventListener("input", this._onInput);
    this._form.addEventListener("submit", this._onSubmit);
  }

  get element() {
    return this._root;
  }

  attachStore(store) {
    this._store = store;
  }

  setItems(items) {
    const list = items || [];
    if (!list.length) {
      this.setFeedState("empty");
      return;
    }
    clear(this._feed);
    for (const item of list) {
      this._feed.append(
        el("article", { class: "comment" }, [
          el("p", { class: "comment-name", text: item.nickname || "Anonymous" }),
          el("p", { class: "comment-time", text: formatCommentTime(item.createdAt) }),
          el("p", { class: "comment-body", text: item.text }),
        ])
      );
    }
  }

  setFeedState(state, message) {
    if (state === "ready") return;
    clear(this._feed);
    const text =
      message ||
      (state === "loading"
        ? ERRORS.feedLoadingNotes
        : state === "empty"
          ? ERRORS.feedEmptyNotes
          : state === "setup"
            ? ERRORS.firebaseUnconfigured
            : state === "error"
              ? ERRORS.commentsSnapshot
              : "");
    const className =
      state === "loading" ? "feed-loading" : state === "empty" ? "feed-empty" : "feed-setup";
    this._feed.append(el("p", { class: className, text }));
  }

  destroy() {
    this._textarea.removeEventListener("input", this._onInput);
    this._form.removeEventListener("submit", this._onSubmit);
  }

  _setStatus(message, isError) {
    this._status.textContent = message;
    this._status.classList.toggle("is-error", Boolean(isError));
  }

  async _handleSubmit(event) {
    event.preventDefault();
    if (this._honeypot.value) {
      this._setStatus(ERRORS.honeypotThanks, false);
      this._form.reset();
      this._countValue.textContent = "0";
      return;
    }

    const nickname = sanitizeNickname(this._nameInput.value, this._limits.nickname);
    const text = sanitizeText(this._textarea.value, this._limits.commentText);
    if (!text) {
      this._setStatus(ERRORS.commentEmpty, true);
      return;
    }
    if (this._rateLimiter && this._rateLimiter.isBlocked()) {
      this._setStatus(ERRORS.commentCooldown, true);
      return;
    }
    if (!this._store) {
      this._setStatus(ERRORS.firebaseUnconfiguredComment, true);
      return;
    }
    if (!this._store.canWrite) {
      this._setStatus(ERRORS.authFailed, true);
      return;
    }

    this._submit.disabled = true;
    this._setStatus(ERRORS.commentPosting, false);
    try {
      await this._store.addComment({
        nickname,
        text,
        dayKey: this.dayKey,
      });
      if (this._rateLimiter) this._rateLimiter.stamp();
      this._form.reset();
      this._countValue.textContent = "0";
      this._setStatus(ERRORS.commentPosted, false);
    } catch (error) {
      console.error(error);
      this._setStatus(ERRORS.commentPost, true);
    } finally {
      this._submit.disabled = false;
    }
  }
}
