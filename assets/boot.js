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

  /* Desktop + iOS Safari emit "…Safari/…" in their UA string
   * without any Chromium-family marker. Flagging them via
   * html[data-ua="safari"] lets CSS gate features that have
   * known Safari quirks — e.g. content-visibility: auto still
   * has :target + find-in-page glitches in Safari 18+. No-op
   * on every other browser. */
  const ua = navigator.userAgent;
  if (
    ua.includes("Safari/") &&
    !ua.includes("Chrome/") &&
    !ua.includes("Chromium/") &&
    !ua.includes("Edg/")
  ) {
    document.documentElement.setAttribute("data-ua", "safari");
  }

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

  /* Run `fn` once hljs has tokenized the first `.line-code code`
   * block. hljs splits text nodes when it runs, so any module
   * that walks the tokenized tree (hotlinks, inline-tokenizer)
   * has to wait or its <a>/<span> wraps get blown away. 1.5s cap
   * + once-guard so a slow CDN can't stall work, and the observer
   * + timeout can't both fire. Resolves immediately if there are
   * no code blocks or hljs already ran. */
  ns.onHljsReady = (fn) => {
    ns.onReady(() => {
      const codes = document.querySelectorAll(".line-code code");
      let fired = false;
      const once = () => {
        if (fired) {
          return;
        }
        fired = true;
        safe("onHljsReady", fn);
      };
      if (codes.length === 0 || codes[0].classList.contains("hljs")) {
        once();
        return;
      }
      const obs = new MutationObserver(() => {
        if (codes[0].classList.contains("hljs")) {
          obs.disconnect();
          once();
        }
      });
      obs.observe(codes[0], { attributes: true, attributeFilter: ["class"] });
      setTimeout(() => {
        obs.disconnect();
        once();
      }, 1500);
    });
  };
})();
