(function () {
  "use strict";

  var slug = document.body.getAttribute("data-slug");
  var partId = parseInt(document.body.getAttribute("data-part"), 10);
  var pageType = document.body.getAttribute("data-page-type");
  var isDocumentsPage = pageType === "documents";
  if (!slug || isNaN(partId)) return;

  var apiBase = "/" + slug + "/api/comments";
  var comments = [];
  var addBtn = null;
  var expandedGroups = {}; // group keys that should render expanded

  /* ------------------------------------------------------------------ */
  /*  Author                                                             */
  /* ------------------------------------------------------------------ */

  function getAuthor() {
    return localStorage.getItem("walkthroughAuthor") || "";
  }

  function ensureAuthor() {
    var author = getAuthor();
    if (author) return author;
    author = prompt("Enter your name for walkthrough comments:");
    if (!author || !author.trim()) return null;
    author = author.trim();
    localStorage.setItem("walkthroughAuthor", author);
    return author;
  }

  /* ------------------------------------------------------------------ */
  /*  API                                                                */
  /* ------------------------------------------------------------------ */

  function fetchComments() {
    fetch(apiBase + "?part=" + partId)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        comments = data;
        renderAllComments();
      })
      .catch(function () { /* silently fail */ });
  }

  function postComment(file, lineFrom, lineTo, body, parentId, callback) {
    var author = ensureAuthor();
    if (!author) return;

    var payload = {
      part: partId,
      file: file,
      lineFrom: lineFrom,
      lineTo: lineTo,
      author: author,
      body: body,
    };
    if (parentId) payload.parentId = parentId;

    fetch(apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (comment) {
        comments.push(comment);
        // Mark this group as expanded so the new comment is immediately visible
        expandedGroups[comment.file + ":" + comment.lineFrom] = true;
        renderAllComments();
        if (callback) callback();
      })
      .catch(function (err) { console.error("Failed to post comment:", err); });
  }

  function deleteComment(id) {
    fetch(apiBase + "/" + id, { method: "DELETE" })
      .then(function () {
        comments = comments.filter(function (c) { return c.id !== id; });
        renderAllComments();
      })
      .catch(function (err) { console.error("Failed to delete comment:", err); });
  }

  function toggleResolved(id, resolved) {
    fetch(apiBase + "/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: resolved }),
    })
      .then(function () {
        for (var i = 0; i < comments.length; i++) {
          if (comments[i].id === id) {
            comments[i].resolved = resolved;
            // Preserve expanded state for this group
            expandedGroups[comments[i].file + ":" + comments[i].lineFrom] = true;
            break;
          }
        }
        renderAllComments();
      })
      .catch(function (err) { console.error("Failed to toggle resolved:", err); });
  }

  /* ------------------------------------------------------------------ */
  /*  Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function getActiveDocFile() {
    if (!isDocumentsPage) return null;
    var activePane = document.querySelector('.doc-tab-pane.active, .doc-tab-pane:not([style*="display: none"])');
    return activePane ? activePane.getAttribute("data-doc-file") : null;
  }

  function renderAllComments() {
    // Remove existing comment rows and indicators
    var existingRows = document.querySelectorAll(".comment-row, .doc-comment-container");
    for (var i = 0; i < existingRows.length; i++) {
      existingRows[i].remove();
    }
    var existingDots = document.querySelectorAll(".comment-indicator");
    for (var i = 0; i < existingDots.length; i++) {
      existingDots[i].remove();
    }

    // Filter comments by active tab when on documents page
    var activeDocFile = getActiveDocFile();
    var commentsToRender = comments;
    if (activeDocFile) {
      commentsToRender = comments.filter(function (c) { return c.file === activeDocFile; });
    }

    // Group root comments by file + lineFrom (indicator anchor point).
    // Replies are grouped with their parent regardless of line range.
    var groups = {};
    var parentGroupKey = {};
    for (var j = 0; j < commentsToRender.length; j++) {
      var c = commentsToRender[j];
      if (c.parentId) continue; // handle replies in second pass
      var key = c.file + ":" + c.lineFrom;
      if (!groups[key]) {
        groups[key] = { file: c.file, lineFrom: c.lineFrom, lineTo: c.lineTo, comments: [] };
      }
      // Expand the group's lineTo to cover the widest range
      if (c.lineTo > groups[key].lineTo) groups[key].lineTo = c.lineTo;
      groups[key].comments.push(c);
      parentGroupKey[c.id] = key;
    }
    // Second pass: attach replies to their parent's group
    for (var j = 0; j < commentsToRender.length; j++) {
      var c = commentsToRender[j];
      if (!c.parentId) continue;
      var gKey = parentGroupKey[c.parentId];
      if (gKey && groups[gKey]) {
        groups[gKey].comments.push(c);
      }
    }

    var keys = Object.keys(groups);
    for (var k = 0; k < keys.length; k++) {
      renderCommentGroup(groups[keys[k]]);
    }
  }

  function findRowForLine(file, lineNum) {
    var tables = document.querySelectorAll('.code-table[data-file="' + CSS.escape(file) + '"]');
    for (var i = 0; i < tables.length; i++) {
      var rows = tables[i].querySelectorAll("tr:not(.comment-row)");
      for (var j = 0; j < rows.length; j++) {
        var numCell = rows[j].querySelector(".line-num");
        if (numCell && parseInt(numCell.textContent, 10) === lineNum) {
          return rows[j];
        }
      }
    }
    return null;
  }

  function findBlockElement(file, blockId) {
    var pane = document.querySelector('.doc-tab-pane[data-doc-file="' + CSS.escape(file) + '"]');
    if (!pane) return null;
    return pane.querySelector('.doc-block[data-block-id="' + blockId + '"]');
  }

  function buildCommentCard(comment, isReply) {
    var isResolved = !isReply && comment.resolved;
    var card = document.createElement("div");
    card.className = "comment-card" + (isReply ? " comment-reply" : "") + (isResolved ? " comment-resolved" : "");
    card.setAttribute("data-comment-id", comment.id);

    var meta = document.createElement("div");
    meta.className = "comment-meta";
    var prefix = isDocumentsPage ? "B" : "L";
    var range = comment.lineFrom === comment.lineTo
      ? prefix + comment.lineFrom
      : prefix + comment.lineFrom + "-" + prefix + comment.lineTo;
    var resolvedLabel = isResolved ? " (resolved)" : "";
    meta.textContent = comment.author + (isReply ? "" : " on " + range) + " \u00b7 " + formatTime(comment.createdAt) + resolvedLabel;

    var body = document.createElement("div");
    body.className = "comment-body";
    body.textContent = comment.body;

    var actions = document.createElement("div");
    actions.className = "comment-card-actions";

    if (!isReply) {
      var resolveBtn = document.createElement("button");
      resolveBtn.className = "comment-resolve-btn";
      resolveBtn.textContent = comment.resolved ? "Unresolve" : "Resolve";
      (function (cid, currentlyResolved) {
        resolveBtn.addEventListener("click", function () {
          toggleResolved(cid, !currentlyResolved);
        });
      })(comment.id, comment.resolved);
      actions.appendChild(resolveBtn);

      var replyBtn = document.createElement("button");
      replyBtn.className = "comment-reply-btn";
      replyBtn.textContent = "Reply";
      (function (c) {
        replyBtn.addEventListener("click", function () {
          showReplyForm(c, card);
        });
      })(comment);
      actions.appendChild(replyBtn);
    }

    var delBtn = document.createElement("button");
    delBtn.className = "comment-delete-btn";
    delBtn.textContent = "Delete";
    (function (cid) {
      delBtn.addEventListener("click", function () { deleteComment(cid); });
    })(comment.id);
    actions.appendChild(delBtn);

    card.appendChild(meta);
    card.appendChild(body);
    if (isReply) {
      // Replies get actions inline immediately
      card.appendChild(actions);
    } else {
      // Root cards: store actions for later — caller appends after thread
      card._actions = actions;
    }
    return card;
  }

  function showReplyForm(parentComment, parentCard) {
    // Remove any existing reply form
    var existing = parentCard.querySelector(".comment-reply-form");
    if (existing) { existing.remove(); return; }

    var author = ensureAuthor();
    if (!author) return;

    var form = document.createElement("div");
    form.className = "comment-reply-form";

    var textarea = document.createElement("textarea");
    textarea.className = "comment-form-textarea";
    textarea.placeholder = "Write a reply...";
    textarea.rows = 2;

    var btnRow = document.createElement("div");
    btnRow.className = "comment-form-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "comment-form-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () { form.remove(); });

    var submitBtn = document.createElement("button");
    submitBtn.className = "comment-form-submit";
    submitBtn.textContent = "Reply";
    submitBtn.addEventListener("click", function () {
      var text = textarea.value.trim();
      if (!text) return;
      postComment(
        parentComment.file,
        parentComment.lineFrom,
        parentComment.lineTo,
        text,
        parentComment.id,
        function () { form.remove(); }
      );
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(submitBtn);
    form.appendChild(textarea);
    form.appendChild(btnRow);

    parentCard.appendChild(form);
    textarea.focus({ preventScroll: true });
  }

  function renderCommentGroup(group) {
    var groupKey = group.file + ":" + group.lineFrom;
    var startExpanded = !!expandedGroups[groupKey];

    // Separate root comments from replies
    var roots = [];
    var repliesByParent = {};
    for (var i = 0; i < group.comments.length; i++) {
      var c = group.comments[i];
      if (c.parentId) {
        if (!repliesByParent[c.parentId]) repliesByParent[c.parentId] = [];
        repliesByParent[c.parentId].push(c);
      } else {
        roots.push(c);
      }
    }

    // Determine if all root comments are resolved
    var totalCount = group.comments.length;
    var allResolved = roots.length > 0 && roots.every(function (r) { return r.resolved; });

    // Render based on page type
    if (isDocumentsPage) {
      // Document page: find the block elements
      var targetBlock = findBlockElement(group.file, group.lineTo);
      if (!targetBlock) return;

      // Find the lineFrom block to place the indicator
      var indicatorBlock = findBlockElement(group.file, group.lineFrom);
      if (!indicatorBlock) indicatorBlock = targetBlock;

      // Create the indicator dot on the lineFrom block's gutter
      var gutter = indicatorBlock.querySelector(".doc-block-gutter");
      if (gutter) {
        var dot = document.createElement("span");
        dot.className = "comment-indicator" + (allResolved ? " comment-indicator-resolved" : "");
        dot.title = totalCount + " comment" + (totalCount === 1 ? "" : "s") + (allResolved ? " (resolved)" : "");
        gutter.appendChild(dot);
      }

      // Build the comment container — expanded if group is in expandedGroups, hidden otherwise
      var commentContainer = document.createElement("div");
      commentContainer.className = "doc-comment-container";
      if (!startExpanded) {
        commentContainer.style.display = "none";
      }

      for (var i = 0; i < roots.length; i++) {
        var rootCard = buildCommentCard(roots[i], false);

        // Render replies for this root
        var childReplies = repliesByParent[roots[i].id] || [];
        if (childReplies.length > 0) {
          var thread = document.createElement("div");
          thread.className = "comment-thread";
          for (var j = 0; j < childReplies.length; j++) {
            thread.appendChild(buildCommentCard(childReplies[j], true));
          }
          rootCard.appendChild(thread);
        }

        // Append actions (Reply/Delete) after the thread
        if (rootCard._actions) {
          rootCard.appendChild(rootCard._actions);
        }

        commentContainer.appendChild(rootCard);
      }

      // Insert after the target block
      targetBlock.parentNode.insertBefore(commentContainer, targetBlock.nextSibling);

      // Click the indicator to toggle comment visibility and highlight blocks
      if (gutter) {
        var indicator = gutter.querySelector(".comment-indicator");
        if (indicator) {
          (function (container, gFile, gFrom, gTo) {
            indicator.addEventListener("click", function (e) {
              e.stopPropagation();
              var visible = container.style.display !== "none";
              if (visible) {
                container.style.display = "none";
              } else {
                container.style.display = "";
                var pane = document.querySelector('.doc-tab-pane[data-doc-file="' + CSS.escape(gFile) + '"]');
                if (pane && window.walkthroughSelectRange) {
                  window.walkthroughSelectRange(pane, gFrom, gTo);
                }
              }
            });
          })(commentContainer, group.file, group.lineFrom, group.lineTo);
        }
      }
    } else {
      // Code page: use table rows
      var targetRow = findRowForLine(group.file, group.lineTo);
      if (!targetRow) return;

      // Find the lineFrom row to place the indicator
      var indicatorRow = findRowForLine(group.file, group.lineFrom);
      if (!indicatorRow) indicatorRow = targetRow;

      // Create the indicator dot on the lineFrom row (yellow = unresolved, green = all resolved)
      var numCell = indicatorRow.querySelector(".line-num");
      if (numCell) {
        var dot = document.createElement("span");
        dot.className = "comment-indicator" + (allResolved ? " comment-indicator-resolved" : "");
        dot.title = totalCount + " comment" + (totalCount === 1 ? "" : "s") + (allResolved ? " (resolved)" : "");
        numCell.insertBefore(dot, numCell.firstChild);
      }

      // Build the comment row — expanded if group is in expandedGroups, hidden otherwise
      var commentRow = document.createElement("tr");
      commentRow.className = "comment-row";
      if (!startExpanded) {
        commentRow.style.display = "none";
      }
      var commentCell = document.createElement("td");
      commentCell.colSpan = 2;
      commentCell.className = "comment-card-cell";

      for (var i = 0; i < roots.length; i++) {
        var rootCard = buildCommentCard(roots[i], false);

        // Render replies for this root
        var childReplies = repliesByParent[roots[i].id] || [];
        if (childReplies.length > 0) {
          var thread = document.createElement("div");
          thread.className = "comment-thread";
          for (var j = 0; j < childReplies.length; j++) {
            thread.appendChild(buildCommentCard(childReplies[j], true));
          }
          rootCard.appendChild(thread);
        }

        // Append actions (Reply/Delete) after the thread
        if (rootCard._actions) {
          rootCard.appendChild(rootCard._actions);
        }

        commentCell.appendChild(rootCard);
      }

      commentRow.appendChild(commentCell);
      targetRow.parentNode.insertBefore(commentRow, targetRow.nextSibling);

      // Click the indicator to toggle comment visibility and highlight lines
      if (numCell) {
        var indicator = numCell.querySelector(".comment-indicator");
        if (indicator) {
          (function (row, gFile, gFrom, gTo) {
            indicator.addEventListener("click", function (e) {
              e.stopPropagation();
              var visible = row.style.display !== "none";
              if (visible) {
                row.style.display = "none";
              } else {
                row.style.display = "";
                var table = numCell.closest(".code-table");
                if (table && window.walkthroughSelectRange) {
                  window.walkthroughSelectRange(table, gFrom, gTo);
                }
              }
            });
          })(commentRow, group.file, group.lineFrom, group.lineTo);
        }
      }
    }
  }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return iso;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Add Comment Button                                                 */
  /* ------------------------------------------------------------------ */

  function createAddButton() {
    var btn = document.createElement("button");
    btn.className = "comment-add-btn";
    btn.textContent = "+ Comment";
    btn.style.display = "none";
    document.body.appendChild(btn);
    return btn;
  }

  function positionAddButton(sel) {
    if (!addBtn) addBtn = createAddButton();

    // Position near the last selected row in the code column
    var selectedElements = isDocumentsPage
      ? document.querySelectorAll(".doc-block.block-selected")
      : document.querySelectorAll(".code-table tr.selected");
    if (selectedElements.length === 0) {
      addBtn.style.display = "none";
      return;
    }

    var lastEl = selectedElements[selectedElements.length - 1];
    var rect = lastEl.getBoundingClientRect();
    var btnLeft = Math.min(rect.right - 100, window.innerWidth - 120);
    addBtn.style.display = "block";
    addBtn.style.position = "fixed";
    addBtn.style.top = (rect.bottom + 4) + "px";
    addBtn.style.left = btnLeft + "px";
    addBtn.style.zIndex = "100";
  }

  function hideAddButton() {
    if (addBtn) addBtn.style.display = "none";
  }

  function findLastSelectedElement() {
    var selector = isDocumentsPage ? ".doc-block.block-selected" : ".code-table tr.selected";
    var selected = document.querySelectorAll(selector);
    return selected.length > 0 ? selected[selected.length - 1] : null;
  }

  function showCommentForm(sel) {
    // Prompt for author name before showing the form
    var author = ensureAuthor();
    if (!author) return;

    hideAddButton();

    // Remove existing form
    var existingForm = document.querySelector(".comment-form-row, .doc-comment-form");
    if (existingForm) existingForm.remove();

    var lastEl = findLastSelectedElement();
    if (!lastEl) return;

    var container = document.createElement("div");
    container.className = "comment-form-container";

    // Build label based on page type (block IDs use "B" prefix on documents page)
    var prefix = isDocumentsPage ? "B" : "L";
    var range = sel.from === sel.to
      ? prefix + sel.from
      : prefix + sel.from + "-" + prefix + sel.to;
    var label = document.createElement("div");
    label.className = "comment-form-label";
    label.textContent = "Comment on " + sel.file + " " + range;

    var textarea = document.createElement("textarea");
    textarea.className = "comment-form-textarea";
    textarea.placeholder = "Write a comment...";
    textarea.rows = 3;

    var btnRow = document.createElement("div");
    btnRow.className = "comment-form-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "comment-form-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () {
      if (isDocumentsPage) {
        var formEl = document.querySelector(".doc-comment-form");
        if (formEl) formEl.remove();
      } else {
        var formRow = document.querySelector(".comment-form-row");
        if (formRow) formRow.remove();
      }
    });

    var submitBtn = document.createElement("button");
    submitBtn.className = "comment-form-submit";
    submitBtn.textContent = "Submit";
    submitBtn.addEventListener("click", function () {
      var text = textarea.value.trim();
      if (!text) return;
      postComment(sel.file, sel.from, sel.to, text, null, function () {
        if (isDocumentsPage) {
          var formEl = document.querySelector(".doc-comment-form");
          if (formEl) formEl.remove();
        } else {
          var formRow = document.querySelector(".comment-form-row");
          if (formRow) formRow.remove();
        }
      });
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(submitBtn);
    container.appendChild(label);
    container.appendChild(textarea);
    container.appendChild(btnRow);

    if (isDocumentsPage) {
      // On documents page: insert form as a div after the last selected block
      var formDiv = document.createElement("div");
      formDiv.className = "doc-comment-form";
      formDiv.appendChild(container);
      lastEl.parentNode.insertBefore(formDiv, lastEl.nextSibling);
    } else {
      // On code pages: insert form as a table row
      var formRow = document.createElement("tr");
      formRow.className = "comment-form-row";
      var formCell = document.createElement("td");
      formCell.colSpan = 2;
      formCell.className = "comment-form-cell";
      formCell.appendChild(container);
      formRow.appendChild(formCell);
      lastEl.parentNode.insertBefore(formRow, lastEl.nextSibling);
    }

    textarea.focus({ preventScroll: true });

    // Scroll the first selected element to the top, accounting for the sticky header
    var firstSelectedSelector = isDocumentsPage ? ".doc-block.block-selected" : ".code-table tr.selected";
    var firstSelected = document.querySelector(firstSelectedSelector);
    if (firstSelected) {
      var topbar = document.querySelector(".topbar");
      var headerHeight = topbar ? topbar.getBoundingClientRect().height : 0;
      var targetY = firstSelected.getBoundingClientRect().top + window.scrollY - headerHeight - 8;
      window.scrollTo({ top: targetY });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Event Listeners                                                    */
  /* ------------------------------------------------------------------ */

  document.addEventListener("walkthroughselectionchange", function () {
    var sel = window.walkthroughSelection;
    if (sel) {
      positionAddButton(sel);
    } else {
      hideAddButton();
    }
  });

  // Add button click handler (delegated since button is created lazily)
  document.addEventListener("click", function (e) {
    if (e.target.classList && e.target.classList.contains("comment-add-btn")) {
      var sel = window.walkthroughSelection;
      if (sel) {
        showCommentForm(sel);
      }
    }
  });

  // Hide the add-comment button on scroll
  window.addEventListener("scroll", function () {
    hideAddButton();
  }, { passive: true });

  // Re-render comments when tabs change on documents page
  document.addEventListener("doctabchange", function () {
    renderAllComments();
  });

  // Load comments on page ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fetchComments);
  } else {
    fetchComments();
  }
})();
