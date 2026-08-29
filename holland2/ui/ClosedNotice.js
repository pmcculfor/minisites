export class ClosedNotice {
  constructor(props) {
    this.root = props.root;
  }

  show() {
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
  }
}
