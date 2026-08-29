export class ConditionsCard {
  constructor(props) {
    this.root = props.root;
    this._loading = this.root.querySelector("#conditions-loading");
    this._error = this.root.querySelector("#conditions-error");
    this._data = this.root.querySelector("#conditions-data");
    this._asOf = this.root.querySelector("#as-of");
  }

  setPhase(phase, extra) {
    const info = extra || {};
    if (phase === "loading") {
      this._loading.hidden = false;
      this._error.hidden = true;
      this._data.hidden = true;
      this.root.setAttribute("aria-busy", "true");
      return;
    }
    if (phase === "error") {
      this._loading.hidden = true;
      this._data.hidden = true;
      this._error.hidden = false;
      this._error.textContent = info.message || "";
      this.root.setAttribute("aria-busy", "false");
      return;
    }
    if (phase === "ready") {
      this._loading.hidden = true;
      this._error.hidden = true;
      this._data.hidden = false;
      if (info.asOf != null && this._asOf) this._asOf.textContent = info.asOf;
      this.root.setAttribute("aria-busy", "false");
    }
  }
}
