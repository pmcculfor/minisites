export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  const props = attrs || {};
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = value;
    } else if (key === "text") {
      node.textContent = value;
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key.startsWith("aria-") || key.startsWith("data-")) {
      node.setAttribute(key, value === true ? "" : String(value));
    } else if (key === "hidden" || key === "required" || key === "disabled" || key === "checked") {
      node[key] = Boolean(value);
    } else if (key === "tabIndex" || key === "tabindex") {
      node.tabIndex = Number(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  const list = children == null ? [] : Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
}
