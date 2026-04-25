(function () {
  "use strict";

  // Only activate on the documents page
  if (document.body.getAttribute("data-page-type") !== "documents") return;

  var anchor = null; // { pane, blockId }
  var currentSelection = []; // array of .doc-block elements

  // Expose selection state and API for comment-client.js
  window.walkthroughSelection = null;
  window.walkthroughSelectRange = function (pane, fromBlock, toBlock) {
    selectBlockRange(pane, pane.getAttribute("data-doc-file"), fromBlock, toBlock);
  };

  function clearSelection() {
    for (var i = 0; i < currentSelection.length; i++) {
      currentSelection[i].classList.remove("block-selected");
    }
    currentSelection = [];
    window.walkthroughSelection = null;
    document.dispatchEvent(new CustomEvent("walkthroughselectionchange"));
  }

  function selectBlockRange(pane, file, fromId, toId) {
    var lo = Math.min(fromId, toId);
    var hi = Math.max(fromId, toId);
    clearSelection();

    var blocks = pane.querySelectorAll(".doc-block");
    for (var i = 0; i < blocks.length; i++) {
      var id = parseInt(blocks[i].getAttribute("data-block-id"), 10);
      if (id >= lo && id <= hi) {
        blocks[i].classList.add("block-selected");
        currentSelection.push(blocks[i]);
      }
    }

    window.walkthroughSelection = { file: file, from: lo, to: hi, type: "block" };
    document.dispatchEvent(new CustomEvent("walkthroughselectionchange"));
    updateHash(file, lo, hi);
  }

  function updateHash(file, lo, hi) {
    var hash = "#" + encodeURIComponent(file) + ":B" + lo;
    if (lo !== hi) hash += "-B" + hi;
    if (history.replaceState) {
      history.replaceState(null, "", hash);
    }
  }

  // Match #<encoded-filepath>:B28 or #<encoded-filepath>:B28-B35
  function parseHash() {
    var hash = window.location.hash;
    if (!hash) return null;

    var colonIdx = hash.lastIndexOf(":");
    if (colonIdx < 1) return null;

    var filePart = decodeURIComponent(hash.substring(1, colonIdx));
    var blocksPart = hash.substring(colonIdx + 1);

    var match = blocksPart.match(/^B(\d+)(?:-B(\d+))?$/);
    if (!match) return null;

    var from = parseInt(match[1], 10);
    var to = match[2] ? parseInt(match[2], 10) : from;
    return { file: filePart, from: from, to: to };
  }

  function findPaneForFile(filePath) {
    var panes = document.querySelectorAll('.doc-tab-pane[data-doc-file="' + CSS.escape(filePath) + '"]');
    return panes.length > 0 ? panes[0] : null;
  }

  document.addEventListener("click", function (e) {
    // Ignore clicks on comment UI elements
    if (e.target.closest(".comment-add-btn") ||
        e.target.closest(".comment-form-container") ||
        e.target.closest(".comment-card") ||
        e.target.closest(".doc-comment-container") ||
        e.target.closest(".comment-indicator")) return;

    var block = e.target.closest(".doc-block");
    var gutter = e.target.closest(".doc-block-gutter");

    if (!block && !gutter) {
      // Click outside blocks — clear selection
      if (currentSelection.length > 0) {
        clearSelection();
        anchor = null;
        if (history.replaceState) {
          history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      }
      return;
    }

    if (gutter) {
      block = gutter.closest(".doc-block");
    }
    if (!block) return;

    var pane = block.closest(".doc-tab-pane");
    if (!pane) return;

    var blockId = parseInt(block.getAttribute("data-block-id"), 10);
    var file = pane.getAttribute("data-doc-file");

    if (e.shiftKey && anchor && anchor.pane === pane) {
      // Shift+click: select range from anchor to clicked block
      e.preventDefault();
      selectBlockRange(pane, file, anchor.blockId, blockId);
    } else {
      // Single click: set new anchor, select single block
      clearSelection();
      block.classList.add("block-selected");
      currentSelection = [block];
      anchor = { pane: pane, blockId: blockId };
      window.walkthroughSelection = { file: file, from: blockId, to: blockId, type: "block" };
      document.dispatchEvent(new CustomEvent("walkthroughselectionchange"));
      updateHash(file, blockId, blockId);
    }
  });

  // On page load, apply selection from URL hash
  function applyHashSelection() {
    var range = parseHash();
    if (!range) return;

    var pane = findPaneForFile(range.file);
    if (!pane) return;

    // Ensure the pane is visible (switch tabs if necessary).
    // Use the public API from doc-tabs.js to avoid double scroll/hash handling.
    var docIndex = parseInt(pane.getAttribute("data-doc-index"), 10);
    if (!isNaN(docIndex) && !pane.classList.contains("active")) {
      if (typeof window.switchDocTab === "function") {
        window.switchDocTab(docIndex);
      }
    }

    selectBlockRange(pane, range.file, range.from, range.to);

    // Scroll the first selected block into view, accounting for the sticky topbar.
    if (currentSelection.length > 0) {
      var topbar = document.querySelector(".topbar");
      var offset = topbar ? topbar.getBoundingClientRect().height + 16 : 16;
      var y = currentSelection[0].getBoundingClientRect().top + window.scrollY - offset;
      var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyHashSelection);
  } else {
    applyHashSelection();
  }

  window.addEventListener("hashchange", function () {
    clearSelection();
    anchor = null;
    applyHashSelection();
  });
})();
