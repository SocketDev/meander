(function () {
  "use strict";

  var defIndex = window.__defIndex;
  if (!defIndex || typeof defIndex !== "object") return;

  var slug = document.body.getAttribute("data-slug");
  if (!slug) return;

  var names = Object.keys(defIndex).sort(function (a, b) {
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
        var def = defIndex[name];
        if (!def) continue;

        // Don't link a name to itself (same file, same line)
        var table = textNode.closest ? textNode.closest(".code-table") : null;
        if (!table) {
          var el = textNode.parentElement;
          while (el && !el.classList.contains("code-table")) el = el.parentElement;
          table = el;
        }
        if (table) {
          var currentFile = table.getAttribute("data-file");
          var row = textNode.parentElement;
          while (row && row.tagName !== "TR") row = row.parentElement;
          if (row && currentFile === def.file) {
            var lineCell = row.querySelector(".line-num");
            if (lineCell && parseInt(lineCell.textContent, 10) === def.line) continue;
          }
        }

        // Add text before match
        if (match.index > lastIndex) {
          parts.push(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        // Create the def-ref span
        var span = document.createElement("span");
        span.className = "def-ref";
        span.setAttribute("data-def-name", name);
        span.setAttribute("data-def-file", def.file);
        span.setAttribute("data-def-line", def.line);
        span.setAttribute("data-def-part", def.part);
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

  function showTooltip(span) {
    if (!tooltip) tooltip = createTooltip();
    var name = span.getAttribute("data-def-name");
    var file = span.getAttribute("data-def-file");
    var line = span.getAttribute("data-def-line");
    var part = span.getAttribute("data-def-part");

    tooltip.innerHTML =
      '<div class="def-tooltip-name">' + name + '</div>' +
      '<div class="def-tooltip-location">' + file + ':' + line + ' (Part ' + part + ')</div>' +
      '<div class="def-tooltip-hint">Click symbol to go to definition</div>';

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

    var part = span.getAttribute("data-def-part");
    var file = span.getAttribute("data-def-file");
    var line = span.getAttribute("data-def-line");
    var currentPart = document.body.getAttribute("data-part");

    var hash = "#" + encodeURIComponent(file) + ":L" + line;

    if (part === currentPart) {
      // Same page — scroll to the line
      window.location.hash = hash;
    } else {
      // Different part — navigate
      window.location.href = "/" + slug + "/part/" + part + hash;
    }
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
