/* Jump-to-file menu — per-file-block dropdown that lists every
 * file on the page. Injected into `.file-head` as a <details>
 * whose <summary> is the .path span. Click the path, get a
 * floating panel of anchored links to every file-block.
 *
 * Two subsystems:
 *   1. Outside-click / pick-a-link closes all open menus and
 *      the menus don't stack (opening one closes the others).
 *   2. IntersectionObserver tracks which file-block is most
 *      visible and marks its row active in every menu. */
"use strict";
(() => {
  const ns = window[Symbol.for("meander:pages")];
  if (!ns) {
    return;
  }

  const MENU = ".wt-files-menu";
  const PANEL_LINK = ".wt-files-panel a";

  const installMenuBehavior = () => {
    for (const menu of document.querySelectorAll(MENU)) {
      menu.addEventListener("toggle", () => {
        if (!menu.open) {
          return;
        }
        /* Scroll the active row into the panel's visible area
         * so the "current file" isn't offscreen when the menu
         * opens on a long list. */
        const panel = menu.querySelector(".wt-files-panel");
        const active = panel?.querySelector("a.active");
        if (!panel || !active) {
          return;
        }
        const panelRect = panel.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const centerOffset =
          activeRect.top -
          panelRect.top -
          panel.clientHeight / 2 +
          active.clientHeight / 2;
        panel.scrollTop += centerOffset;
      });
    }

    document.addEventListener("click", (e) => {
      const target = e.target;
      const panelLink = target.closest?.(PANEL_LINK);
      const summary = target.closest?.(`${MENU} > summary`);
      const clickedMenu = summary?.parentElement;
      const insideMenu = target.closest?.(MENU);
      const closeAll = panelLink || (!insideMenu && !summary);
      for (const menu of document.querySelectorAll(`${MENU}[open]`)) {
        if (closeAll || (summary && menu !== clickedMenu)) {
          menu.open = false;
        }
      }
    });
  };

  const installFileTracking = () => {
    const blocks = [...document.querySelectorAll(".file-block[id]")];
    if (blocks.length === 0) {
      return;
    }
    const panels = [...document.querySelectorAll(".wt-files-panel")];
    if (panels.length === 0) {
      return;
    }

    const setActive = (id) => {
      for (const panel of panels) {
        for (const link of panel.querySelectorAll("a.active")) {
          link.classList.remove("active");
        }
        if (!id) {
          continue;
        }
        const match = panel.querySelector(`a[href="#${CSS.escape(id)}"]`);
        match?.classList.add("active");
      }
    };

    const visible = new Set();
    const pickTopmost = () => {
      let best = null;
      let bestTop = Infinity;
      for (const block of visible) {
        const top = block.getBoundingClientRect().top;
        if (top >= 0 && top < bestTop) {
          best = block;
          bestTop = top;
        }
      }
      if (!best) {
        let bestNegTop = -Infinity;
        for (const block of visible) {
          const top = block.getBoundingClientRect().top;
          if (top < 0 && top > bestNegTop) {
            best = block;
            bestNegTop = top;
          }
        }
      }
      setActive(best?.id ?? null);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visible.add(entry.target);
          } else {
            visible.delete(entry.target);
          }
        }
        pickTopmost();
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );

    for (const block of blocks) {
      io.observe(block);
    }
  };

  ns.onReady(() => {
    installMenuBehavior();
    installFileTracking();
  });
})();
