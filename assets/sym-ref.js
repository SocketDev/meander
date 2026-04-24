(function () {
  "use strict";

  /* Symbol table: window[Symbol.for("meander:symbols")] maps
   * each exported name to an array of locations. The array
   * shape lets us preserve overloads (same name, different
   * lines in one file) and cross-file duplicates (e.g. a
   * `parse` function in several ecosystem-specific files)
   * instead of silently dropping them like the old singleton
   * shape did. */
  var symbols = window[Symbol.for("meander:symbols")];
  if (!symbols || typeof symbols !== "object") return;

  var slug = document.body.getAttribute("data-slug");
  if (!slug) return;

  var names = Object.keys(symbols).sort(function (a, b) {
    return b.length - a.length; // longest first to avoid partial matches
  });
  if (names.length === 0) return;

  // Build a regex that matches any definition name as a whole word
  var escaped = names.map(function (n) {
    return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  var pattern = new RegExp("\\b(" + escaped.join("|") + ")\\b", "g");

  // Process all highlighted code elements — runs after highlight.js
  function processCodeElements() {
    var codeEls = document.querySelectorAll(".line-code code");

    for (var i = 0; i < codeEls.length; i++) {
      processNode(codeEls[i]);
    }
  }

  /* True when the match is the name at its own definition
   * line/file — we don't wrap those (a symbol shouldn't link
   * to itself). Checks against every location in `locs`. */
  function isSelfReference(textNode, locs) {
    var table = textNode.closest ? textNode.closest(".code-table") : null;
    if (!table) {
      var el = textNode.parentElement;
      while (el && !el.classList.contains("code-table")) el = el.parentElement;
      table = el;
    }
    if (!table) return false;
    var currentFile = table.getAttribute("data-file");
    var row = textNode.parentElement;
    while (row && row.tagName !== "TR") row = row.parentElement;
    if (!row) return false;
    var lineCell = row.querySelector(".line-num");
    if (!lineCell) return false;
    var currentLine = parseInt(lineCell.textContent, 10);
    for (var i = 0; i < locs.length; i++) {
      if (locs[i].file === currentFile && locs[i].line === currentLine) {
        return true;
      }
    }
    return false;
  }

  function processNode(node) {
    // Walk text nodes within the already-highlighted code
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    var textNodes = [];
    var current;
    while ((current = walker.nextNode())) {
      textNodes.push(current);
    }

    for (var i = 0; i < textNodes.length; i++) {
      var textNode = textNodes[i];
      var text = textNode.textContent;
      if (!text) continue;

      // Skip text inside existing def-ref spans
      if (textNode.parentElement && textNode.parentElement.classList.contains("def-ref")) continue;

      var parts = [];
      var lastIndex = 0;
      var match;
      pattern.lastIndex = 0;

      while ((match = pattern.exec(text)) !== null) {
        var name = match[1];
        var locs = symbols[name];
        if (!locs || locs.length === 0) continue;
        if (isSelfReference(textNode, locs)) continue;

        // Add text before match
        if (match.index > lastIndex) {
          parts.push(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        /* Stash the full locs array on the span via a JSON
         * attribute so click + tooltip handlers can route
         * single vs. multi-location cases without re-reading
         * `symbols`. Single-location keeps the original flat
         * data-* attrs for backwards style selectors. */
        var span = document.createElement("span");
        span.className = "def-ref";
        span.setAttribute("data-def-name", name);
        if (locs.length === 1) {
          var only = locs[0];
          span.setAttribute("data-def-file", only.file);
          span.setAttribute("data-def-line", only.line);
          span.setAttribute("data-def-part", only.part);
        } else {
          span.setAttribute("data-def-count", locs.length);
          span.setAttribute("data-def-locs", JSON.stringify(locs));
        }
        span.textContent = name;
        parts.push(span);

        lastIndex = match.index + match[0].length;
      }

      if (parts.length === 0) continue;

      // Add remaining text
      if (lastIndex < text.length) {
        parts.push(document.createTextNode(text.slice(lastIndex)));
      }

      // Replace the text node with the parts
      var parent = textNode.parentNode;
      for (var j = 0; j < parts.length; j++) {
        parent.insertBefore(parts[j], textNode);
      }
      parent.removeChild(textNode);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Tooltip                                                            */
  /* ------------------------------------------------------------------ */

  var tooltip = null;

  function createTooltip() {
    var el = document.createElement("div");
    el.className = "def-tooltip";
    el.style.display = "none";
    document.body.appendChild(el);
    return el;
  }

  function locsFromSpan(span) {
    var packed = span.getAttribute("data-def-locs");
    if (packed) {
      try { return JSON.parse(packed); } catch { return []; }
    }
    var file = span.getAttribute("data-def-file");
    var line = span.getAttribute("data-def-line");
    var part = span.getAttribute("data-def-part");
    if (!file) return [];
    return [{ file: file, line: parseInt(line, 10), part: parseInt(part, 10) }];
  }

  function showTooltip(span) {
    if (!tooltip) tooltip = createTooltip();
    var name = span.getAttribute("data-def-name");
    var locs = locsFromSpan(span);

    var header = '<div class="def-tooltip-name">' + name + "</div>";
    if (locs.length === 1) {
      var loc = locs[0];
      tooltip.innerHTML =
        header +
        '<div class="def-tooltip-location">' + loc.file + ':' + loc.line + ' (Part ' + loc.part + ')</div>' +
        '<div class="def-tooltip-hint">Click symbol to go to definition</div>';
    } else {
      var items = locs.map(function (loc) {
        return '<div class="def-tooltip-location">' + loc.file + ':' + loc.line + ' (Part ' + loc.part + ')</div>';
      }).join("");
      tooltip.innerHTML =
        header + items +
        '<div class="def-tooltip-hint">Click to pick a location (' + locs.length + ' defined)</div>';
    }

    var rect = span.getBoundingClientRect();
    tooltip.style.display = "block";
    tooltip.style.left = rect.left + "px";
    tooltip.style.top = (rect.bottom + 4) + "px";
  }

  function hideTooltip() {
    if (tooltip) tooltip.style.display = "none";
  }

  /* ------------------------------------------------------------------ */
  /*  Event listeners                                                    */
  /* ------------------------------------------------------------------ */

  function navigateTo(loc) {
    var hash = "#" + encodeURIComponent(loc.file) + ":L" + loc.line;
    var currentPart = document.body.getAttribute("data-part");
    if (String(loc.part) === currentPart) {
      window.location.hash = hash;
    } else {
      window.location.href = "/" + slug + "/part/" + loc.part + hash;
    }
  }

  /* Minimal disambiguator: browser-native prompt picks the
   * location number. Keeps the asset script dep-free. Consumers
   * that want a fancier popup can override by listening to the
   * click earlier and calling preventDefault(). */
  function pickLocation(locs) {
    if (locs.length === 1) return locs[0];
    var lines = ["Choose a definition:"];
    for (var i = 0; i < locs.length; i++) {
      lines.push((i + 1) + ". " + locs[i].file + ":" + locs[i].line + " (Part " + locs[i].part + ")");
    }
    var answer = window.prompt(lines.join("\n"), "1");
    if (!answer) return null;
    var n = parseInt(answer, 10);
    if (!(n >= 1 && n <= locs.length)) return null;
    return locs[n - 1];
  }

  document.addEventListener("mouseover", function (e) {
    var span = e.target.closest ? e.target.closest(".def-ref") : null;
    if (span) {
      showTooltip(span);
    } else {
      hideTooltip();
    }
  });

  document.addEventListener("click", function (e) {
    var span = e.target.closest ? e.target.closest(".def-ref") : null;
    if (!span) return;

    var locs = locsFromSpan(span);
    if (locs.length === 0) return;
    var loc = locs.length === 1 ? locs[0] : pickLocation(locs);
    if (!loc) return;
    navigateTo(loc);
  });

  // Run after highlight.js has processed the code
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      // Small delay to ensure highlight.js has run
      setTimeout(processCodeElements, 100);
    });
  } else {
    setTimeout(processCodeElements, 100);
  }
})();
