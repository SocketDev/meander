/* Walkthrough boot — shared namespace + runtime primitives.
 *
 * Namespace: window[Symbol.for('meander:pages')]. Boot is the
 * first script in the inlined bundle, so later modules always
 * see `ns` populated.
 *
 * Primitives:
 *   - ns.storageGet(key)        guarded localStorage read
 *   - ns.storageSet(key, value) guarded write (null ⇒ remove)
 *   - ns.onReady(fn)            run after DOMContentLoaded */
"use strict";
(() => {
  const ns = (window[Symbol.for("meander:pages")] ??= {});

  ns.storageGet = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  ns.storageSet = (key, value) => {
    try {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    } catch {
      /* private mode / quota / disabled — ignore */
    }
  };

  const safe = (tag, fn) => {
    try {
      fn();
    } catch (e) {
      console.error(`[meander:pages] ${tag}:`, e);
    }
  };

  ns.onReady = (fn) => {
    const run = () => safe("onReady", fn);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
  };
})();
