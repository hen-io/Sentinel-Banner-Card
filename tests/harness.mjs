// Loads a card file into a VM with minimal DOM stubs. Run tests: node --test tests/*.test.mjs
import fs from "node:fs";
import vm from "node:vm";

export function loadCard(file) {
  const defined = new Map();
  const noop = () => {};
  class HTMLElement {
    attachShadow() {
      this.shadowRoot = { innerHTML: "", addEventListener: noop, querySelector: () => null };
      return this.shadowRoot;
    }
    addEventListener() {}
    appendChild() {}
    dispatchEvent() {}
  }
  const context = {
    HTMLElement,
    customElements: {
      get: (tag) => defined.get(tag),
      define: (tag, ctor) => {
        if (defined.has(tag)) throw new Error(`already defined: ${tag}`);
        defined.set(tag, ctor);
      },
    },
    window: {},
    document: { addEventListener: noop, removeEventListener: noop, createElement: () => ({}) },
    console,
    CustomEvent: class {},
    Intl,
    URL,
    history: {},
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    setInterval: noop,
    clearInterval: noop,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { defined, context, evaluate: (code) => vm.runInContext(code, context) };
}

export function fakeHass(handler) {
  const calls = [];
  return {
    calls,
    states: {},
    connection: { addEventListener() {}, removeEventListener() {} },
    async callWS(msg) {
      calls.push(msg.type);
      return handler(msg);
    },
  };
}
