(function () {
  "use strict";

  // Guard: only run on documents page
  var pageType = document.body.getAttribute("data-page-type");
  if (pageType !== "documents") return;

  var btn = null;
  var dropdown = null;

  /* ------------------------------------------------------------------ */
  /*  SVG Icon                                                           */
  /* ------------------------------------------------------------------ */

  function createIcon() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    // List/outline icon - three horizontal lines
    var line1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line1.setAttribute("x1", "3");
    line1.setAttribute("y1", "6");
    line1.setAttribute("x2", "21");
    line1.setAttribute("y2", "6");
    svg.appendChild(line1);

    var line2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line2.setAttribute("x1", "3");
    line2.setAttribute("y1", "12");
    line2.setAttribute("x2", "21");
    line2.setAttribute("y2", "12");
    svg.appendChild(line2);

    var line3 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line3.setAttribute("x1", "3");
    line3.setAttribute("y1", "18");
    line3.setAttribute("x2", "21");
    line3.setAttribute("y2", "18");
    svg.appendChild(line3);

    return svg;
  }

  /* ------------------------------------------------------------------ */
  /*  Button Creation                                                    */
  /* ------------------------------------------------------------------ */

  function createTocButton() {
    var button = document.createElement("button");
    button.className = "doc-toc-btn";
    button.title = "Table of Contents";
    button.setAttribute("aria-label", "Table of Contents");
    button.appendChild(createIcon());
    button.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleTocDropdown();
    });
    document.body.appendChild(button);
    return button;
  }

  /* ------------------------------------------------------------------ */
  /*  Dropdown Creation                                                  */
  /* ------------------------------------------------------------------ */

  function createTocDropdown() {
    var el = document.createElement("div");
    el.className = "doc-toc-dropdown";
    el.style.display = "none";

    // Header
    var header = document.createElement("div");
    header.className = "doc-toc-dropdown-header";
    header.textContent = "Table of Contents";
    el.appendChild(header);

    // List container
    var list = document.createElement("div");
    list.className = "doc-toc-list";
    el.appendChild(list);

    document.body.appendChild(el);
    return el;
  }

  /* ------------------------------------------------------------------ */
  /*  Dropdown Visibility                                                */
  /* ------------------------------------------------------------------ */

  function toggleTocDropdown() {
    if (!dropdown) {
      dropdown = createTocDropdown();
    }

    var visible = dropdown.style.display !== "none";
    if (visible) {
      dropdown.style.display = "none";
    } else {
      populateToc();
      dropdown.style.display = "flex";
    }
  }

  function closeTocDropdown() {
    if (dropdown) {
      dropdown.style.display = "none";
    }
  }

  /* ------------------------------------------------------------------ */
  /*  TOC Population                                                     */
  /* ------------------------------------------------------------------ */

  function populateToc() {
    var activePane = document.querySelector(".doc-tab-pane.active");
    if (!activePane) return;

    var docFile = activePane.getAttribute("data-doc-file");
    if (!docFile || !window.__docHeadings) return;

    var docData = window.__docHeadings.find(function (d) { return d.file === docFile; });
    if (!docData) return;

    var list = dropdown.querySelector(".doc-toc-list");
    list.innerHTML = "";

    for (var i = 0; i < docData.headings.length; i++) {
      var h = docData.headings[i];
      var item = document.createElement("a");
      item.className = "doc-toc-item doc-toc-h" + h.level;
      item.href = "#" + h.id;
      item.textContent = h.text;

      // Capture heading ID in closure
      (function (headingId) {
        item.addEventListener("click", function (e) {
          e.preventDefault();
          var target = document.getElementById(headingId);
          if (target) {
            var topbar = document.querySelector(".topbar");
            var offset = topbar ? topbar.getBoundingClientRect().height + 16 : 16;
            var y = target.getBoundingClientRect().top + window.scrollY - offset;
            window.scrollTo({ top: y, behavior: "smooth" });
          }
          closeTocDropdown();
        });
      })(h.id);

      list.appendChild(item);
    }

    // Update scroll spy immediately after populating
    updateScrollSpy();
  }

  /* ------------------------------------------------------------------ */
  /*  Scroll Spy                                                         */
  /* ------------------------------------------------------------------ */

  function updateScrollSpy() {
    if (!dropdown || dropdown.style.display === "none") return;

    var activePane = document.querySelector(".doc-tab-pane.active");
    if (!activePane) return;

    // Get all headings with IDs within the active pane
    var headings = activePane.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]");
    if (headings.length === 0) return;

    var topbar = document.querySelector(".topbar");
    var offset = topbar ? topbar.getBoundingClientRect().height + 20 : 20;

    // Find the current heading (last one above the offset line)
    var current = null;
    for (var i = 0; i < headings.length; i++) {
      var rect = headings[i].getBoundingClientRect();
      if (rect.top <= offset) {
        current = headings[i];
      }
    }

    // Update active state on TOC items
    var items = dropdown.querySelectorAll(".doc-toc-item");
    for (var j = 0; j < items.length; j++) {
      items[j].classList.remove("active");
      if (current && items[j].getAttribute("href") === "#" + current.id) {
        items[j].classList.add("active");
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Initialization                                                     */
  /* ------------------------------------------------------------------ */

  function activeDocHasHeadings() {
    var activePane = document.querySelector(".doc-tab-pane.active");
    if (!activePane || !window.__docHeadings) return false;
    var docFile = activePane.getAttribute("data-doc-file");
    var docData = window.__docHeadings.find(function (d) { return d.file === docFile; });
    return !!(docData && docData.headings.length > 0);
  }

  function updateButtonVisibility() {
    if (!btn) return;
    btn.style.display = activeDocHasHeadings() ? "" : "none";
  }

  function init() {
    btn = createTocButton();
    updateButtonVisibility();

    // Listen for tab changes to repopulate TOC and update button visibility
    document.addEventListener("doctabchange", function () {
      updateButtonVisibility();
      // Close the dropdown if the new tab has no headings
      if (!activeDocHasHeadings()) {
        closeTocDropdown();
      } else if (dropdown && dropdown.style.display !== "none") {
        populateToc();
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", function (e) {
      if (!dropdown) return;
      var isClickInside = dropdown.contains(e.target) || btn.contains(e.target);
      if (!isClickInside) {
        closeTocDropdown();
      }
    });

    // Scroll spy
    window.addEventListener("scroll", updateScrollSpy, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
