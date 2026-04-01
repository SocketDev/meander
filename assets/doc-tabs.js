(function () {
  "use strict";

  // Guard: only run on documents page
  var pageType = document.body.getAttribute("data-page-type");
  if (pageType !== "documents") return;

  /* ------------------------------------------------------------------ */
  /*  Tab Switching                                                      */
  /* ------------------------------------------------------------------ */

  function switchToTab(index, updateHash) {
    var tabs = document.querySelectorAll(".doc-tab-btn");
    var panes = document.querySelectorAll(".doc-tab-pane");

    for (var i = 0; i < tabs.length; i++) {
      var isActive = i === index;
      tabs[i].classList.toggle("active", isActive);
      panes[i].classList.toggle("active", isActive);
      panes[i].style.display = isActive ? "block" : "none";
    }

    // Update URL hash
    if (updateHash !== false) {
      var pane = panes[index];
      if (pane) {
        var filePath = pane.getAttribute("data-doc-file");
        if (filePath && history.replaceState) {
          history.replaceState(null, "", "#" + encodeURIComponent(filePath));
        }
      }
    }

    // Fire custom event for TOC to listen to
    document.dispatchEvent(new CustomEvent("doctabchange", { detail: { index: index } }));
  }

  // Expose for programmatic tab switching
  window.switchDocTab = function (index) {
    switchToTab(index, true);
  };

  /* ------------------------------------------------------------------ */
  /*  Hash Parsing                                                       */
  /* ------------------------------------------------------------------ */

  // Hash format:
  // #<encoded-file-path>                    - tab selection only
  // #<encoded-file-path>:<heading-id>      - tab + scroll to heading
  // #<encoded-file-path>:B<n>              - tab + scroll to block
  // #<encoded-file-path>:B<n>-B<m>         - tab + block range selection
  function parseHash() {
    var hash = window.location.hash;
    if (!hash || hash.length < 2) return null;

    // Remove leading #
    hash = hash.substring(1);

    // Find the colon separator (if any)
    var colonIdx = hash.lastIndexOf(":");

    var filePath;
    var anchor = "";

    if (colonIdx > 0) {
      // Has anchor part
      filePath = hash.substring(0, colonIdx);
      anchor = hash.substring(colonIdx + 1);
    } else {
      // No anchor, just file path
      filePath = hash;
    }

    // Decode the file path
    try {
      filePath = decodeURIComponent(filePath);
    } catch (e) {
      return null;
    }

    return { filePath: filePath, anchor: anchor };
  }

  function findTabIndexByFilePath(filePath) {
    var panes = document.querySelectorAll(".doc-tab-pane");
    for (var i = 0; i < panes.length; i++) {
      if (panes[i].getAttribute("data-doc-file") === filePath) {
        return i;
      }
    }
    return -1;
  }

  /* ------------------------------------------------------------------ */
  /*  Scroll to Target                                                   */
  /* ------------------------------------------------------------------ */

  // Scroll an element into view below the sticky topbar.
  function scrollBelowTopbar(el) {
    var topbar = document.querySelector(".topbar");
    var offset = topbar ? topbar.getBoundingClientRect().height + 16 : 16;
    var y = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: y, behavior: "smooth" });
  }

  function scrollToTarget(anchor) {
    if (!anchor) return;

    // Check if it's a heading ID (not starting with B)
    if (!anchor.startsWith("B")) {
      var heading = document.getElementById(anchor);
      if (heading) {
        scrollBelowTopbar(heading);
      }
      return;
    }

    // Check for block ID: B<n> or B<n>-B<m>
    var blockMatch = anchor.match(/^B(\d+)(?:-B(\d+))?$/);
    if (blockMatch) {
      var blockId = blockMatch[1];
      var block = document.querySelector('.doc-tab-pane.active .doc-block[data-block-id="' + blockId + '"]');
      if (block) {
        scrollBelowTopbar(block);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Apply Hash on Load/Change                                          */
  /* ------------------------------------------------------------------ */

  function applyHash() {
    var parsed = parseHash();
    if (!parsed) return;

    var index = findTabIndexByFilePath(parsed.filePath);
    if (index < 0) return;

    // Switch to the tab without updating hash (we're reading from hash)
    switchToTab(index, false);

    // Scroll to anchor if present
    if (parsed.anchor) {
      // Small delay to allow DOM to settle after tab switch
      setTimeout(function () {
        scrollToTarget(parsed.anchor);
      }, 50);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Event Handlers                                                     */
  /* ------------------------------------------------------------------ */

  // Tab button click handler
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".doc-tab-btn");
    if (!btn) return;

    var index = parseInt(btn.getAttribute("data-doc-index"), 10);
    if (!isNaN(index)) {
      e.preventDefault();
      switchToTab(index, true);
    }
  });

  // Cross-reference link click handler
  document.addEventListener("click", function (e) {
    var link = e.target.closest("[data-doc-ref]");
    if (!link) return;

    var index = parseInt(link.getAttribute("data-doc-ref"), 10);
    var anchor = link.getAttribute("data-doc-anchor") || "";

    if (!isNaN(index)) {
      e.preventDefault();

      // Update URL hash with file path and anchor
      var panes = document.querySelectorAll(".doc-tab-pane");
      var pane = panes[index];
      if (pane) {
        var filePath = pane.getAttribute("data-doc-file");
        if (filePath) {
          var hash = "#" + encodeURIComponent(filePath);
          if (anchor) {
            hash += ":" + anchor;
          }
          if (history.pushState) {
            history.pushState(null, "", hash);
          }
        }
      }

      // Switch to the tab
      switchToTab(index, false);

      // Scroll to anchor if present
      if (anchor) {
        setTimeout(function () {
          scrollToTarget(anchor);
        }, 50);
      }
    }
  });

  // Hash change handler
  window.addEventListener("hashchange", function () {
    applyHash();
  });

  /* ------------------------------------------------------------------ */
  /*  Initialization                                                     */
  /* ------------------------------------------------------------------ */

  function init() {
    // Apply hash on load if present.
    // Skip block-reference hashes (e.g. #file.md:B5) — block-select.js owns those.
    var hash = window.location.hash;
    if (hash && hash.length > 1 && !/:[Bb]\d/.test(hash)) {
      applyHash();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();