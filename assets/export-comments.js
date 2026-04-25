(function () {
  "use strict";

  var slug = document.body.getAttribute("data-slug");
  if (!slug) return;

  var dropdown = null;

  /* ------------------------------------------------------------------ */
  /*  SVG Icon                                                           */
  /* ------------------------------------------------------------------ */

  function createIcon() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    var path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path1.setAttribute("d", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4");
    svg.appendChild(path1);

    var polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", "7 10 12 15 17 10");
    svg.appendChild(polyline);

    var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", "12");
    line.setAttribute("y1", "15");
    line.setAttribute("x2", "12");
    line.setAttribute("y2", "3");
    svg.appendChild(line);

    return svg;
  }

  /* ------------------------------------------------------------------ */
  /*  Button                                                             */
  /* ------------------------------------------------------------------ */

  function createButton() {
    var btn = document.createElement("button");
    btn.className = "export-btn";
    btn.title = "Export comments";
    btn.setAttribute("aria-label", "Export comments");
    btn.appendChild(createIcon());

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleDropdown();
    });

    return btn;
  }

  /* ------------------------------------------------------------------ */
  /*  Dropdown                                                           */
  /* ------------------------------------------------------------------ */

  function createDropdown() {
    var el = document.createElement("div");
    el.className = "export-dropdown";
    el.style.display = "none";

    var header = document.createElement("div");
    header.className = "export-dropdown-header";
    header.textContent = "Export Comments";
    el.appendChild(header);

    var exportAll = document.createElement("a");
    exportAll.className = "export-option";
    exportAll.href = "/" + slug + "/api/comments/export";
    exportAll.setAttribute("download", slug + "-comments-all.json");
    exportAll.textContent = "Export All";
    el.appendChild(exportAll);

    var exportUnresolved = document.createElement("a");
    exportUnresolved.className = "export-option";
    exportUnresolved.href = "/" + slug + "/api/comments/export?unresolved=true";
    exportUnresolved.setAttribute("download", slug + "-comments-unresolved.json");
    exportUnresolved.textContent = "Export Unresolved";
    el.appendChild(exportUnresolved);

    document.body.appendChild(el);
    return el;
  }

  function positionDropdown() {
    if (!dropdown) return;
    var btn = document.querySelector(".export-btn");
    if (!btn) return;

    var btnRect = btn.getBoundingClientRect();
    var dropdownWidth = 200;

    dropdown.style.position = "fixed";
    dropdown.style.top = (btnRect.bottom + 8) + "px";
    dropdown.style.right = (window.innerWidth - btnRect.right) + "px";
    dropdown.style.zIndex = "100";
    dropdown.style.width = dropdownWidth + "px";
  }

  function toggleDropdown() {
    if (!dropdown) {
      dropdown = createDropdown();
    }
    var isHidden = dropdown.style.display === "none";
    if (isHidden) {
      positionDropdown();
      dropdown.style.display = "block";
    } else {
      dropdown.style.display = "none";
    }
  }

  function hideDropdown() {
    if (dropdown) {
      dropdown.style.display = "none";
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Init                                                               */
  /* ------------------------------------------------------------------ */

  function init() {
    var topbar = document.querySelector(".topbar");
    if (!topbar) return;

    var actions = topbar.querySelector(".topbar-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "topbar-actions";
      topbar.appendChild(actions);
    }

    var btn = createButton();
    // Insert export button before the unresolved button (if it exists)
    var unresolvedBtn = actions.querySelector(".unresolved-btn");
    if (unresolvedBtn) {
      actions.insertBefore(btn, unresolvedBtn);
    } else {
      actions.appendChild(btn);
    }
  }

  document.addEventListener("click", function (e) {
    if (!dropdown) return;
    var btn = document.querySelector(".export-btn");
    var isClickInside = dropdown.contains(e.target) || btn.contains(e.target);
    if (!isClickInside) {
      hideDropdown();
    }
  });

  window.addEventListener("resize", function () {
    if (dropdown && dropdown.style.display !== "none") {
      positionDropdown();
    }
  });

  window.addEventListener("scroll", function () {
    hideDropdown();
  }, { passive: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
