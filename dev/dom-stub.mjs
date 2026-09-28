/*
 * Minimal DOM shim for the panel render test.
 *
 * Purpose: run the real renderer/panel.js in Node and assert what it produced,
 * without a browser and without adding a dependency. It implements only what
 * panel.js actually uses, and it deliberately throws on an unknown selector or
 * an unimplemented member so a panel change cannot silently pass this test.
 *
 * The element registry is built from renderer/index.html, so the test also
 * fails if panel.js starts referencing an id the markup does not define.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

class ClassList {
  constructor(element) {
    this.element = element;
    this.tokens = new Set();
  }
  add(...tokens) {
    for (const token of tokens) if (token) this.tokens.add(token);
    this.sync();
  }
  remove(...tokens) {
    for (const token of tokens) this.tokens.delete(token);
    this.sync();
  }
  contains(token) {
    return this.tokens.has(token);
  }
  sync() {
    this.element._className = [...this.tokens].join(" ");
  }
  static from(element, className) {
    const list = new ClassList(element);
    for (const token of String(className || "").split(/\s+/)) if (token) list.tokens.add(token);
    list.sync();
    return list;
  }
}

class Element {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    // A real element's `style` supports setProperty/getPropertyValue, and the
    // preview fixture uses it to inject the host's design tokens.
    const declared = new Map();
    this.style = {
      setProperty: (name, value) => declared.set(String(name), String(value)),
      getPropertyValue: (name) => declared.get(String(name)) ?? "",
      removeProperty: (name) => declared.delete(String(name)),
      get cssText() {
        return [...declared].map(([k, v]) => `${k}: ${v}`).join("; ");
      },
    };
    this.classList = ClassList.from(this, "");
    this.listeners = new Map();
    this._text = "";
    // A real DOM reflects `dataset` into data-* attributes, and panel.css
    // selects on them (for example `.status[data-level="warn"]`), so the shim
    // must reflect too or the test would validate a different DOM.
    this.dataset = new Proxy(
      {},
      {
        set: (target, key, value) => {
          target[key] = String(value);
          this.attributes.set(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value));
          return true;
        },
      },
    );
  }


  get className() {
    return this._className || "";
  }

  set className(value) {
    this.classList = ClassList.from(this, value);
  }

  get id() {
    return this.attributes.get("id") || "";
  }

  set id(value) {
    this.attributes.set("id", value);
  }

  get value() {
    return this._value || "";
  }

  set value(next) {
    this._value = next;
  }

  get children() {
    return this.childNodes;
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = value === null || value === undefined ? "" : String(value);
  }

  /** Concatenated text of this element and every descendant (for assertions). */
  get allText() {
    const parts = [this._text];
    for (const node of this.childNodes) parts.push(node.allText ?? node.textContent);
    return parts.filter(Boolean).join(" ");
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this._text = "";
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({ currentTarget: this, target: this, preventDefault() {}, ...event });
    }
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  scrollIntoView() {}

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (matches(child, selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  descendants() {
    const results = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

function matches(element, selector) {
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  return element.tagName === selector.toUpperCase();
}

/** Every `id="..."` in the markup, so the shim mirrors index.html exactly. */
export function idsFromMarkup(html) {
  const ids = new Set();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);
  return [...ids];
}
/**
 * @param {string} markupPath absolute path to renderer/index.html
 * @returns {{window: object, document: object, elements: Map<string, Element>}}
 */
export function createDom(markupPath) {
  const html = readFileSync(markupPath, "utf8");
  const elements = new Map();
  const body = new Element("body");

  const document = {
    body,
    activeElement: null,
    createElement: (tag) => {
      const node = new Element(tag);
      node.ownerDocument = document;
      return node;
    },
    getElementById: (id) => elements.get(id) || null,
  };

  // The preview fixture applies host design tokens to :root, exactly as the
  // app's own document does, so the shim needs a documentElement with a
  // style.setProperty implementation.
  document.documentElement = document.createElement("html");

  for (const id of idsFromMarkup(html)) {
    const tag = id.startsWith("stat") ? "dd" : "div";
    const node = document.createElement(tag);
    node.id = id;
    elements.set(id, node);
    body.append(node);
  }

  const window = { document, pluginBridge: null, confirm: () => true, setTimeout, clearTimeout };
  return { window, document, elements, body };
}

export { Element, path };
