/* Annotation-md cleanup orchestrator.
 *
 * For each .annotation-md container: mark ready (reveals the
 * opacity:0 placeholder), wrap JSDoc tags, group into blocks,
 * order. Second pass via rAF catches any late-landing hydration
 * in the same tick.
 *
 * Gated on ns.onHljsReady so @example block highlighting has
 * the hljs grammar loaded. No-op on pages without hljs. */
"use strict";
(() => {
  const ns = window[Symbol.for("meander:pages")];
  if (!ns) {
    return;
  }

  const cleanupAnnotationProse = () => {
    if (!ns.wrapJsdocTags || !ns.groupJsdocBlocks) {
      return;
    }
    for (const container of document.querySelectorAll(".annotation-md")) {
      /* Mark the container as processed so CSS can reveal it.
       * `.annotation-md` ships opacity:0 to avoid a flash of
       * unstyled JSDoc markers (@example / @param / etc.
       * rendered as plain text for one frame before pills land).
       * Setting the class at the START of the pass lets the
       * browser composite the cleaned DOM in the same paint as
       * this function's mutations. */
      container.classList.add("wt-annotation-md-ready");
      ns.wrapJsdocTags(container);
      ns.groupJsdocBlocks(container);
    }
  };

  ns.onHljsReady(() => {
    cleanupAnnotationProse();
    requestAnimationFrame(cleanupAnnotationProse);
  });
})();
