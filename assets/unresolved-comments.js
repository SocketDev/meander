(function () {
  "use strict";

  var slug = document.body.getAttribute("data-slug");
  if (!slug) return;

  var apiBase = "/" + slug + "/api/comments/unresolved";
  var dropdown = null;
  var unresolvedCount = 0;

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
    path1.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
    svg.appendChild(path1);

    return svg;
  }

  /* ------------------------------------------------------------------ */
  /*  Button                                                             */
  /* ------------------------------------------------------------------ */

  function createButton() {
    var btn = document.createElement("button");
    btn.className = "unresolved-btn";
    btn.title = "View unresolved comments";

    btn.appendChild(createIcon());

    var badge = document.createElement("span");
    badge.className = "unresolved-badge";
    badge.style.display = "none";
    btn.appendChild(badge);

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleDropdown();
    });

    return btn;
  }

  function updateBadge(count) {
    unresolvedCount = count;
    var badge = document.querySelector(".unresolved-badge");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Dropdown                                                           */
  /* ------------------------------------------------------------------ */

  function createDropdown() {
    var el = document.createElement("div");
    el.className = "unresolved-dropdown";
    el.style.display = "none";

    var header = document.createElement("div");
    header.className = "unresolved-dropdown-header";
    header.textContent = "Unresolved Comments";
    el.appendChild(header);

    var list = document.createElement("div");
    list.className = "unresolved-list";
    el.appendChild(list);

    var empty = document.createElement("div");
    empty.className = "unresolved-empty";
    empty.textContent = "No unresolved comments";
    empty.style.display = "none";
    el.appendChild(empty);

    document.body.appendChild(el);
    return el;
  }

  function positionDropdown() {
    if (!dropdown) return;
    var btn = document.querySelector(".unresolved-btn");
    if (!btn) return;
    var rect = btn.getBoundingClientRect();
    dropdown.style.position = "fixed";
    dropdown.style.top = (rect.bottom + 8) + "px";
    dropdown.style.right = (window.innerWidth - rect.right) + "px";
  }

  function toggleDropdown() {
    if (!dropdown) {
      dropdown = createDropdown();
    }

    var visible = dropdown.style.display !== "none";
    if (visible) {
      dropdown.style.display = "none";
      return;
    }

    positionDropdown();
    dropdown.style.display = "block";
    fetchAndRenderComments();
  }

  function closeDropdown() {
    if (dropdown) {
      dropdown.style.display = "none";
    }
  }

  /* ------------------------------------------------------------------ */
  /*  API                                                                */
  /* ------------------------------------------------------------------ */

  function fetchAndRenderComments() {
    var list = dropdown.querySelector(".unresolved-list");
    var empty = dropdown.querySelector(".unresolved-empty");
    list.innerHTML = '<div class="unresolved-loading">Loading...</div>';
    empty.style.display = "none";

    fetch(apiBase)
      .then(function (r) { return r.json(); })
      .then(function (comments) {
        updateBadge(comments.length);
        renderComments(comments);
      })
      .catch(function (err) {
        console.error("Failed to fetch unresolved comments:", err);
        list.innerHTML = '<div class="unresolved-error">Failed to load</div>';
      });
  }

  /* ------------------------------------------------------------------ */
  /*  Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function renderComments(comments) {
    var list = dropdown.querySelector(".unresolved-list");
    var empty = dropdown.querySelector(".unresolved-empty");
    list.innerHTML = "";

    if (comments.length === 0) {
      empty.style.display = "block";
      return;
    }

    var grouped = {};
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      var key = "Part " + c.part;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(c);
    }

    var parts = Object.keys(grouped);
    for (var p = 0; p < parts.length; p++) {
      var partLabel = parts[p];
      var partComments = grouped[partLabel];

      var groupHeader = document.createElement("div");
      groupHeader.className = "unresolved-group-header";
      groupHeader.textContent = partLabel + " (" + partComments.length + ")";
      list.appendChild(groupHeader);

      for (var j = 0; j < partComments.length; j++) {
        var comment = partComments[j];
        var item = createCommentItem(comment);
        list.appendChild(item);
      }
    }
  }

  function createCommentItem(comment) {
    var item = document.createElement("a");
    item.className = "unresolved-item";
    var range = comment.lineFrom === comment.lineTo
      ? "L" + comment.lineFrom
      : "L" + comment.lineFrom + "-L" + comment.lineTo;
    item.href = "/" + slug + "/part/" + comment.part + "#" + encodeURIComponent(comment.file) + ":" + range;

    var fileLine = document.createElement("div");
    fileLine.className = "unresolved-item-file";
    fileLine.textContent = comment.file + " " + range;

    var author = document.createElement("span");
    author.className = "unresolved-item-author";
    author.textContent = comment.author;

    var preview = document.createElement("div");
    preview.className = "unresolved-item-preview";
    preview.textContent = truncate(comment.body, 80);

    var meta = document.createElement("div");
    meta.className = "unresolved-item-meta";
    meta.appendChild(author);
    meta.appendChild(document.createTextNode(" \u00b7 "));
    meta.appendChild(document.createTextNode(formatTime(comment.createdAt)));

    item.appendChild(fileLine);
    item.appendChild(preview);
    item.appendChild(meta);

    item.addEventListener("click", function (e) {
      e.preventDefault();
      window.location.href = item.href;
    });

    return item;
  }

  function truncate(str, max) {
    if (str.length <= max) return str;
    return str.substring(0, max - 3) + "...";
  }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      var now = new Date();
      var diffMs = now - d;
      var diffMins = Math.floor(diffMs / 60000);
      var diffHours = Math.floor(diffMs / 3600000);
      var diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return "just now";
      if (diffMins < 60) return diffMins + "m ago";
      if (diffHours < 24) return diffHours + "h ago";
      if (diffDays < 7) return diffDays + "d ago";
      return d.toLocaleDateString();
    } catch (_) {
      return iso;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Initialization                                                     */
  /* ------------------------------------------------------------------ */

  function init() {
    var topbar = document.querySelector(".topbar");
    if (!topbar) return;

    var btn = createButton();
    topbar.appendChild(btn);

    document.addEventListener("click", function (e) {
      if (!dropdown) return;
      if (dropdown.style.display === "none") return;
      if (dropdown.contains(e.target)) return;
      if (e.target.closest && e.target.closest(".unresolved-btn")) return;
      closeDropdown();
    });

    window.addEventListener("scroll", function () {
      if (dropdown && dropdown.style.display !== "none") {
        positionDropdown();
      }
    }, { passive: true });

    window.addEventListener("resize", function () {
      if (dropdown && dropdown.style.display !== "none") {
        positionDropdown();
      }
    }, { passive: true });

    fetch(apiBase)
      .then(function (r) { return r.json(); })
      .then(function (comments) {
        updateBadge(comments.length);
      })
      .catch(function () { /* silently fail */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();