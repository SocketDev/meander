;(function () {
  'use strict'

  const slug = document.body.getAttribute('data-slug')
  const partId = parseInt(document.body.getAttribute('data-part'), 10)
  const pageType = document.body.getAttribute('data-page-type')
  const isDocumentsPage = pageType === 'documents'
  if (!slug || isNaN(partId)) {return}

  /* When meander emits data-comment-backend on <body>, the HTML
   * is hosted off-origin (GH Pages, Cloudflare Pages, etc.) and
   * the comment API lives on a Val Town val at the given URL.
   * Without the attribute we assume same-origin (Val Town
   * serving both HTML + API) and hit /<slug>/api/comments. */
  const backendBase = (
    document.body.getAttribute('data-comment-backend') || ''
  ).replace(/\/+$/, '')
  const apiBase = backendBase
    ? backendBase + '/' + slug + '/api/comments'
    : '/' + slug + '/api/comments'
  let comments = []
  let addBtn = null
  const expandedGroups = {} // group keys that should render expanded

  /* ------------------------------------------------------------------ */
  /*  Auth (email magic-code + JWT bearer)                                */
  /* ------------------------------------------------------------------ */

  /* localStorage keys. Versioned so a schema change can force all
   * sessions to re-sign-in by bumping the suffix. */
  const TOKEN_KEY = 'meander:auth:v1:token'
  const EMAIL_KEY = 'meander:auth:v1:email'
  const authBase = backendBase ? backendBase + '/api/auth' : '/api/auth'
  /* Demo-mode flag is set at runtime from GET /api/auth/me. When
   * true, writes fail server-side with 403 — we show a banner +
   * visually dim the composer rather than hiding it. */
  const demoMode = document.body.getAttribute('data-demo-mode') === 'true'

  const FETCH_TIMEOUT_MS = 10000

  /**
   * Build an AbortSignal that fires after FETCH_TIMEOUT_MS, optionally
   * composed with a caller-supplied signal via AbortSignal.any() (ES2024).
   * Falls back to the timeout-only signal in older runtimes.
   */
  function requestSignal(userSignal) {
    if (
      typeof AbortSignal === 'undefined' ||
      typeof AbortSignal.timeout !== 'function'
    ) {
      return undefined
    }
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    if (!userSignal) {return timeoutSignal}
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([timeoutSignal, userSignal])
    }
    return timeoutSignal
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || ''
  }
  function getEmail() {
    return localStorage.getItem(EMAIL_KEY) || ''
  }
  function setSession(token, email) {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(EMAIL_KEY, email)
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EMAIL_KEY)
  }

  /**
   * fetch wrapper that attaches Authorization when a token is
   * stored and auto-clears the session on 401 (expired / rotated).
   */
  function authFetch(url, init) {
    init = init || {}
    const headers = {}
    if (init.headers) {
      for (const k in init.headers) {
        if (Object.prototype.hasOwnProperty.call(init.headers, k)) {
          headers[k] = init.headers[k]
        }
      }
    }
    const token = getToken()
    if (token) {
      headers['Authorization'] = 'Bearer ' + token
    }
    init.headers = headers
    const signal = requestSignal(init.signal)
    if (signal) {
      init.signal = signal
    }
    return fetch(url, init).then(function (r) {
      if (r.status === 401 && token) {
        clearSession()
      }
      return r
    })
  }

  function requestMagicCode(email) {
    return fetch(authBase + '/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
      signal: requestSignal(),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) {
          throw new Error(data.error || 'request failed')
        }
        return data
      })
    })
  }

  function verifyMagicCode(email, code) {
    return fetch(authBase + '/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, code: code }),
      signal: requestSignal(),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) {
          throw new Error(data.error || 'verify failed')
        }
        return data
      })
    })
  }

  function signIn(callback) {
    let email = prompt('Email address to sign in with:')
    if (!email || !email.trim()) {return}
    email = email.trim()
    requestMagicCode(email)
      .then(function () {
        const code = prompt('Check your email for a 6-digit code. Enter it here:')
        if (!code || !code.trim()) {return}
        return verifyMagicCode(email, code.trim()).then(function (data) {
          setSession(data.token, data.email)
          if (callback) {callback()}
        })
      })
      .catch(function (err) {
        alert('Sign-in failed: ' + (err && err.message ? err.message : err))
      })
  }

  function ensureSignedIn(callback) {
    if (getToken()) {
      callback()
      return
    }
    signIn(callback)
  }

  /* ------------------------------------------------------------------ */
  /*  API                                                                */
  /* ------------------------------------------------------------------ */

  function fetchComments() {
    authFetch(apiBase + '?part=' + partId)
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        comments = data
        renderAllComments()
      })
      .catch(function () {
        /* silently fail */
      })
  }

  function postComment(file, lineFrom, lineTo, body, parentId, callback) {
    if (demoMode) {
      alert("This is a demo — comments can be composed but aren't saved.")
      return
    }
    ensureSignedIn(function () {
      const payload = {
        part: partId,
        file: file,
        lineFrom: lineFrom,
        lineTo: lineTo,
        body: body,
      }
      if (parentId) {payload.parentId = parentId}
      authFetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) {
              throw new Error(data.error || 'post failed')
            }
            return data
          })
        })
        .then(function (comment) {
          comments.push(comment)
          expandedGroups[comment.file + ':' + comment.lineFrom] = true
          renderAllComments()
          if (callback) {callback()}
        })
        .catch(function (err) {
          alert('Failed to post: ' + (err && err.message ? err.message : err))
        })
    })
  }

  function deleteComment(id) {
    if (demoMode) {
      return
    }
    ensureSignedIn(function () {
      authFetch(apiBase + '/' + id, { method: 'DELETE' })
        .then(function () {
          comments = comments.filter(function (c) {
            return c.id !== id
          })
          renderAllComments()
        })
        .catch(function (err) {
          console.error('Failed to delete comment:', err)
        })
    })
  }

  function toggleResolved(id, resolved) {
    if (demoMode) {
      return
    }
    ensureSignedIn(function () {
      authFetch(apiBase + '/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: resolved }),
      })
        .then(function () {
          for (let i = 0; i < comments.length; i++) {
            if (comments[i].id === id) {
              comments[i].resolved = resolved
              expandedGroups[comments[i].file + ':' + comments[i].lineFrom] =
                true
              break
            }
          }
          renderAllComments()
        })
        .catch(function (err) {
          console.error('Failed to toggle resolved:', err)
        })
    })
  }

  /* ------------------------------------------------------------------ */
  /*  Sign-in widget + demo-mode banner                                   */
  /* ------------------------------------------------------------------ */

  /* Lazy auth widget — only renders when the user is signed in
   * (showing their email + a sign-out affordance). When signed
   * out the widget is absent; the sign-in prompt fires lazily
   * from "+ Comment" / Reply / Resolve actions instead. */
  function renderAuthUi() {
    const existing = document.querySelector('.mdr-auth')
    if (existing) {existing.parentNode.removeChild(existing)}
    const email = getEmail()
    if (!email) {return}
    const el = document.createElement('div')
    el.className = 'mdr-auth'
    const span = document.createElement('span')
    span.className = 'mdr-auth-email'
    span.textContent = email
    const signOut = document.createElement('button')
    signOut.type = 'button'
    signOut.className = 'mdr-auth-btn mdr-auth-signout'
    signOut.textContent = 'Sign out'
    signOut.addEventListener('click', function () {
      clearSession()
      renderAuthUi()
    })
    el.appendChild(span)
    el.appendChild(signOut)
    const slot = document.querySelector('.topbar-actions')
    if (slot) {
      slot.appendChild(el)
    } else {
      document.body.appendChild(el)
    }
  }

  function signInFlow(after) {
    signIn(after)
  }

  function renderDemoBanner() {
    if (!demoMode) {return}
    const key = 'meander:demo-banner-dismissed-v1'
    if (localStorage.getItem(key) === 'true') {return}
    const el = document.createElement('div')
    el.className = 'mdr-demo-banner'
    const msg = document.createElement('span')
    msg.textContent = "Demo mode — comments you write here aren't saved."
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'mdr-demo-dismiss'
    dismiss.textContent = '×'
    dismiss.setAttribute('aria-label', 'Dismiss demo banner')
    dismiss.addEventListener('click', function () {
      localStorage.setItem(key, 'true')
      el.parentNode.removeChild(el)
    })
    el.appendChild(msg)
    el.appendChild(dismiss)
    document.body.insertBefore(el, document.body.firstChild)
  }

  /* ------------------------------------------------------------------ */
  /*  Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function getActiveDocFile() {
    if (!isDocumentsPage) {return null}
    const activePane = document.querySelector('.doc-tab-pane.active')
    return activePane ? activePane.getAttribute('data-doc-file') : null
  }

  function renderAllComments() {
    // Remove existing comment rows and indicators
    const existingRows = document.querySelectorAll(
      '.comment-row, .doc-comment-container',
    )
    for (let i = 0; i < existingRows.length; i++) {
      existingRows[i].remove()
    }
    const existingDots = document.querySelectorAll('.comment-indicator')
    for (let i = 0; i < existingDots.length; i++) {
      existingDots[i].remove()
    }

    // Filter comments by active tab when on documents page
    const activeDocFile = getActiveDocFile()
    let commentsToRender = comments
    if (activeDocFile) {
      commentsToRender = comments.filter(function (c) {
        return c.file === activeDocFile
      })
    }

    // Group root comments by file + lineFrom (indicator anchor point).
    // Replies are grouped with their parent regardless of line range.
    const groups = {}
    const parentGroupKey = {}
    for (let j = 0; j < commentsToRender.length; j++) {
      const c = commentsToRender[j]
      if (c.parentId) {continue} // handle replies in second pass
      const key = c.file + ':' + c.lineFrom
      if (!groups[key]) {
        groups[key] = {
          file: c.file,
          lineFrom: c.lineFrom,
          lineTo: c.lineTo,
          comments: [],
        }
      }
      // Expand the group's lineTo to cover the widest range
      if (c.lineTo > groups[key].lineTo) {groups[key].lineTo = c.lineTo}
      groups[key].comments.push(c)
      parentGroupKey[c.id] = key
    }
    // Second pass: attach replies to their parent's group
    for (let j = 0; j < commentsToRender.length; j++) {
      const c = commentsToRender[j]
      if (!c.parentId) {continue}
      const gKey = parentGroupKey[c.parentId]
      if (gKey && groups[gKey]) {
        groups[gKey].comments.push(c)
      }
    }

    const keys = Object.keys(groups)
    for (let k = 0; k < keys.length; k++) {
      renderCommentGroup(groups[keys[k]])
    }
  }

  function findRowForLine(file, lineNum) {
    const tables = document.querySelectorAll(
      '.code-table[data-file="' + CSS.escape(file) + '"]',
    )
    for (let i = 0; i < tables.length; i++) {
      const rows = tables[i].querySelectorAll('tr:not(.comment-row)')
      for (let j = 0; j < rows.length; j++) {
        const numCell = rows[j].querySelector('.line-num')
        if (numCell && parseInt(numCell.textContent, 10) === lineNum) {
          return rows[j]
        }
      }
    }
    return null
  }

  function findBlockElement(file, blockId) {
    const pane = document.querySelector(
      '.doc-tab-pane[data-doc-file="' + CSS.escape(file) + '"]',
    )
    if (!pane) {return null}
    return pane.querySelector('.doc-block[data-block-id="' + blockId + '"]')
  }

  function buildCommentCard(comment, isReply) {
    const isResolved = !isReply && comment.resolved
    const card = document.createElement('div')
    card.className =
      'comment-card' +
      (isReply ? ' comment-reply' : '') +
      (isResolved ? ' comment-resolved' : '')
    card.setAttribute('data-comment-id', comment.id)

    const meta = document.createElement('div')
    meta.className = 'comment-meta'
    const prefix = isDocumentsPage ? 'B' : 'L'
    const range =
      comment.lineFrom === comment.lineTo
        ? prefix + comment.lineFrom
        : prefix + comment.lineFrom + '-' + prefix + comment.lineTo
    const resolvedLabel = isResolved ? ' (resolved)' : ''
    meta.appendChild(
      document.createTextNode(
        comment.author + (isReply ? '' : ' on ' + range) + ' \u00b7 ',
      ),
    )
    meta.appendChild(timeElement(comment.createdAt))
    if (resolvedLabel) {
      meta.appendChild(document.createTextNode(resolvedLabel))
    }

    const body = document.createElement('div')
    body.className = 'comment-body'
    body.textContent = comment.body

    const actions = document.createElement('div')
    actions.className = 'comment-card-actions'

    if (!isReply) {
      const resolveBtn = document.createElement('button')
      resolveBtn.type = 'button'
      resolveBtn.className = 'comment-resolve-btn'
      resolveBtn.textContent = comment.resolved ? 'Unresolve' : 'Resolve'
      resolveBtn.setAttribute('aria-pressed', comment.resolved ? 'true' : 'false')
      ;(function (cid, currentlyResolved) {
        resolveBtn.addEventListener('click', function () {
          toggleResolved(cid, !currentlyResolved)
        })
      })(comment.id, comment.resolved)
      actions.appendChild(resolveBtn)

      const replyBtn = document.createElement('button')
      replyBtn.type = 'button'
      replyBtn.className = 'comment-reply-btn'
      replyBtn.textContent = 'Reply'
      ;(function (c) {
        replyBtn.addEventListener('click', function () {
          showReplyForm(c, card)
        })
      })(comment)
      actions.appendChild(replyBtn)
    }

    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'comment-delete-btn'
    delBtn.textContent = 'Delete'
    ;(function (cid) {
      delBtn.addEventListener('click', function () {
        deleteComment(cid)
      })
    })(comment.id)
    actions.appendChild(delBtn)

    card.appendChild(meta)
    card.appendChild(body)
    if (isReply) {
      // Replies get actions inline immediately
      card.appendChild(actions)
    } else {
      // Root cards: store actions for later — caller appends after thread
      card._actions = actions
    }
    return card
  }

  function showReplyForm(parentComment, parentCard) {
    // Remove any existing reply form
    const existing = parentCard.querySelector('.comment-reply-form')
    if (existing) {
      existing.remove()
      return
    }

    const author = ensureAuthor()
    if (!author) {return}

    const form = document.createElement('div')
    form.className = 'comment-reply-form'

    const textarea = document.createElement('textarea')
    textarea.className = 'comment-form-textarea'
    textarea.placeholder = 'Write a reply...'
    textarea.rows = 2

    const btnRow = document.createElement('div')
    btnRow.className = 'comment-form-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'comment-form-cancel'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', function () {
      form.remove()
    })

    const submitBtn = document.createElement('button')
    submitBtn.type = 'button'
    submitBtn.className = 'comment-form-submit'
    submitBtn.textContent = 'Reply'
    submitBtn.addEventListener('click', function () {
      const text = textarea.value.trim()
      if (!text) {return}
      postComment(
        parentComment.file,
        parentComment.lineFrom,
        parentComment.lineTo,
        text,
        parentComment.id,
        function () {
          form.remove()
        },
      )
    })

    btnRow.appendChild(cancelBtn)
    btnRow.appendChild(submitBtn)
    form.appendChild(textarea)
    form.appendChild(btnRow)

    parentCard.appendChild(form)
    textarea.focus({ preventScroll: true })
  }

  function renderCommentGroup(group) {
    const groupKey = group.file + ':' + group.lineFrom
    const startExpanded = !!expandedGroups[groupKey]

    // Separate root comments from replies
    const roots = []
    const repliesByParent = {}
    for (let i = 0; i < group.comments.length; i++) {
      const c = group.comments[i]
      if (c.parentId) {
        if (!repliesByParent[c.parentId]) {repliesByParent[c.parentId] = []}
        repliesByParent[c.parentId].push(c)
      } else {
        roots.push(c)
      }
    }

    // Determine if all root comments are resolved
    const totalCount = group.comments.length
    const allResolved =
      roots.length > 0 &&
      roots.every(function (r) {
        return r.resolved
      })

    // Render based on page type
    if (isDocumentsPage) {
      // Document page: find the block elements
      const targetBlock = findBlockElement(group.file, group.lineTo)
      if (!targetBlock) {return}

      // Find the lineFrom block to place the indicator
      let indicatorBlock = findBlockElement(group.file, group.lineFrom)
      if (!indicatorBlock) {indicatorBlock = targetBlock}

      // Create the indicator dot on the lineFrom block's gutter
      const gutter = indicatorBlock.querySelector('.doc-block-gutter')
      if (gutter) {
        const dot = document.createElement('span')
        dot.className =
          'comment-indicator' +
          (allResolved ? ' comment-indicator-resolved' : '')
        const indicatorLabel =
          totalCount +
          ' comment' +
          (totalCount === 1 ? '' : 's') +
          (allResolved ? ' (resolved)' : '')
        dot.title = indicatorLabel
        /* The dot toggles a comments panel below the row. AT
         * users need a button affordance + keyboard activation;
         * sighted users still see the same dot. tabindex=0 makes
         * it focusable, role=button announces it correctly, and
         * aria-expanded reflects the panel state (toggled below
         * by the click handler). */
        dot.setAttribute('role', 'button')
        dot.setAttribute('tabindex', '0')
        dot.setAttribute('aria-label', indicatorLabel)
        dot.setAttribute('aria-expanded', startExpanded ? 'true' : 'false')
        gutter.appendChild(dot)
      }

      // Build the comment container — expanded if group is in expandedGroups, hidden otherwise
      const commentContainer = document.createElement('div')
      commentContainer.className = 'doc-comment-container'
      if (!startExpanded) {
        commentContainer.style.display = 'none'
      }

      for (let i = 0; i < roots.length; i++) {
        const rootCard = buildCommentCard(roots[i], false)

        // Render replies for this root
        const childReplies = repliesByParent[roots[i].id] || []
        if (childReplies.length > 0) {
          const thread = document.createElement('div')
          thread.className = 'comment-thread'
          for (let j = 0; j < childReplies.length; j++) {
            thread.appendChild(buildCommentCard(childReplies[j], true))
          }
          rootCard.appendChild(thread)
        }

        // Append actions (Reply/Delete) after the thread
        if (rootCard._actions) {
          rootCard.appendChild(rootCard._actions)
        }

        commentContainer.appendChild(rootCard)
      }

      // Insert after the target block
      targetBlock.parentNode.insertBefore(
        commentContainer,
        targetBlock.nextSibling,
      )

      // Click the indicator to toggle comment visibility and highlight blocks
      if (gutter) {
        const indicator = gutter.querySelector('.comment-indicator')
        if (indicator) {
          ;(function (container, gFile, gFrom, gTo) {
            const toggle = function () {
              const visible = container.style.display !== 'none'
              if (visible) {
                container.style.display = 'none'
                indicator.setAttribute('aria-expanded', 'false')
              } else {
                container.style.display = ''
                indicator.setAttribute('aria-expanded', 'true')
                const pane = document.querySelector(
                  '.doc-tab-pane[data-doc-file="' + CSS.escape(gFile) + '"]',
                )
                if (pane && window.walkthroughSelectRange) {
                  window.walkthroughSelectRange(pane, gFrom, gTo)
                }
              }
            }
            indicator.addEventListener('click', function (e) {
              e.stopPropagation()
              toggle()
            })
            indicator.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                toggle()
              }
            })
          })(commentContainer, group.file, group.lineFrom, group.lineTo)
        }
      }
    } else {
      // Code page: use table rows
      const targetRow = findRowForLine(group.file, group.lineTo)
      if (!targetRow) {return}

      // Find the lineFrom row to place the indicator
      let indicatorRow = findRowForLine(group.file, group.lineFrom)
      if (!indicatorRow) {indicatorRow = targetRow}

      // Create the indicator dot on the lineFrom row (yellow = unresolved, green = all resolved)
      const numCell = indicatorRow.querySelector('.line-num')
      if (numCell) {
        const dot = document.createElement('span')
        dot.className =
          'comment-indicator' +
          (allResolved ? ' comment-indicator-resolved' : '')
        const indicatorLabel =
          totalCount +
          ' comment' +
          (totalCount === 1 ? '' : 's') +
          (allResolved ? ' (resolved)' : '')
        dot.title = indicatorLabel
        dot.setAttribute('role', 'button')
        dot.setAttribute('tabindex', '0')
        dot.setAttribute('aria-label', indicatorLabel)
        dot.setAttribute('aria-expanded', startExpanded ? 'true' : 'false')
        numCell.insertBefore(dot, numCell.firstChild)
      }

      // Build the comment row — expanded if group is in expandedGroups, hidden otherwise
      const commentRow = document.createElement('tr')
      commentRow.className = 'comment-row'
      if (!startExpanded) {
        commentRow.style.display = 'none'
      }
      const commentCell = document.createElement('td')
      commentCell.colSpan = 2
      commentCell.className = 'comment-card-cell'

      for (let i = 0; i < roots.length; i++) {
        const rootCard = buildCommentCard(roots[i], false)

        // Render replies for this root
        const childReplies = repliesByParent[roots[i].id] || []
        if (childReplies.length > 0) {
          const thread = document.createElement('div')
          thread.className = 'comment-thread'
          for (let j = 0; j < childReplies.length; j++) {
            thread.appendChild(buildCommentCard(childReplies[j], true))
          }
          rootCard.appendChild(thread)
        }

        // Append actions (Reply/Delete) after the thread
        if (rootCard._actions) {
          rootCard.appendChild(rootCard._actions)
        }

        commentCell.appendChild(rootCard)
      }

      commentRow.appendChild(commentCell)
      targetRow.parentNode.insertBefore(commentRow, targetRow.nextSibling)

      // Click the indicator to toggle comment visibility and highlight lines
      if (numCell) {
        const indicator = numCell.querySelector('.comment-indicator')
        if (indicator) {
          ;(function (row, gFile, gFrom, gTo) {
            const toggle = function () {
              const visible = row.style.display !== 'none'
              if (visible) {
                row.style.display = 'none'
                indicator.setAttribute('aria-expanded', 'false')
              } else {
                row.style.display = ''
                indicator.setAttribute('aria-expanded', 'true')
                const table = numCell.closest('.code-table')
                if (table && window.walkthroughSelectRange) {
                  window.walkthroughSelectRange(table, gFrom, gTo)
                }
              }
            }
            indicator.addEventListener('click', function (e) {
              e.stopPropagation()
              toggle()
            })
            indicator.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                toggle()
              }
            })
          })(commentRow, group.file, group.lineFrom, group.lineTo)
        }
      }
    }
  }

  /**
   * Returns "3 hours ago" / "yesterday" / "last week" via
   * Intl.RelativeTimeFormat (numeric: 'auto'). Falls back to absolute
   * date+time on runtimes without RelativeTimeFormat.
   */
  function formatTime(iso) {
    try {
      const d = new Date(iso)
      if (
        typeof Intl === 'undefined' ||
        typeof Intl.RelativeTimeFormat !== 'function'
      ) {
        return (
          d.toLocaleDateString() +
          ' ' +
          d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        )
      }
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
      const diffSec = Math.round((d.getTime() - Date.now()) / 1000)
      const abs = Math.abs(diffSec)
      if (abs < 60) {return rtf.format(diffSec, 'second')}
      if (abs < 3600) {return rtf.format(Math.round(diffSec / 60), 'minute')}
      if (abs < 86400) {return rtf.format(Math.round(diffSec / 3600), 'hour')}
      if (abs < 86400 * 7) {return rtf.format(Math.round(diffSec / 86400), 'day')}
      if (abs < 86400 * 30)
        {return rtf.format(Math.round(diffSec / (86400 * 7)), 'week')}
      if (abs < 86400 * 365)
        {return rtf.format(Math.round(diffSec / (86400 * 30)), 'month')}
      return rtf.format(Math.round(diffSec / (86400 * 365)), 'year')
    } catch (_) {
      return iso
    }
  }

  /**
   * Build a semantic <time datetime="..."> element with the absolute
   * timestamp in the title attribute (so hover surfaces the precise time).
   */
  function timeElement(iso) {
    const el = document.createElement('time')
    el.setAttribute('datetime', iso)
    try {
      const d = new Date(iso)
      el.setAttribute('title', d.toLocaleString())
    } catch (_) {
      /* leave title unset */
    }
    el.textContent = formatTime(iso)
    return el
  }

  /* ------------------------------------------------------------------ */
  /*  Add Comment Button                                                 */
  /* ------------------------------------------------------------------ */

  function createAddButton() {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'comment-add-btn'
    btn.textContent = '+ Comment'
    btn.setAttribute('aria-label', 'Add a comment on the selected lines')
    btn.style.display = 'none'
    document.body.appendChild(btn)
    return btn
  }

  function positionAddButton(sel) {
    if (!addBtn) {addBtn = createAddButton()}

    // Position near the last selected row in the code column
    const selectedElements = isDocumentsPage
      ? document.querySelectorAll('.doc-block.block-selected')
      : document.querySelectorAll('.code-table tr.selected')
    if (selectedElements.length === 0) {
      addBtn.style.display = 'none'
      return
    }

    const lastEl = selectedElements[selectedElements.length - 1]
    const rect = lastEl.getBoundingClientRect()
    const btnLeft = Math.min(rect.right - 100, window.innerWidth - 120)
    addBtn.style.display = 'block'
    addBtn.style.position = 'fixed'
    addBtn.style.top = rect.bottom + 4 + 'px'
    addBtn.style.left = btnLeft + 'px'
    addBtn.style.zIndex = '100'
  }

  function hideAddButton() {
    if (addBtn) {addBtn.style.display = 'none'}
  }

  function findLastSelectedElement() {
    const selector = isDocumentsPage
      ? '.doc-block.block-selected'
      : '.code-table tr.selected'
    const selected = document.querySelectorAll(selector)
    return selected.length > 0 ? selected[selected.length - 1] : null
  }

  function showCommentForm(sel) {
    // Prompt for author name before showing the form
    const author = ensureAuthor()
    if (!author) {return}

    hideAddButton()

    // Remove existing form
    const existingForm = document.querySelector(
      '.comment-form-row, .doc-comment-form',
    )
    if (existingForm) {existingForm.remove()}

    const lastEl = findLastSelectedElement()
    if (!lastEl) {return}

    const container = document.createElement('div')
    container.className = 'comment-form-container'

    // Build label based on page type (block IDs use "B" prefix on documents page)
    const prefix = isDocumentsPage ? 'B' : 'L'
    const range =
      sel.from === sel.to
        ? prefix + sel.from
        : prefix + sel.from + '-' + prefix + sel.to
    const label = document.createElement('div')
    label.className = 'comment-form-label'
    label.textContent = 'Comment on ' + sel.file + ' ' + range

    const textarea = document.createElement('textarea')
    textarea.className = 'comment-form-textarea'
    textarea.placeholder = 'Write a comment...'
    textarea.rows = 3

    const btnRow = document.createElement('div')
    btnRow.className = 'comment-form-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'comment-form-cancel'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', function () {
      if (isDocumentsPage) {
        const formEl = document.querySelector('.doc-comment-form')
        if (formEl) {formEl.remove()}
      } else {
        const formRow = document.querySelector('.comment-form-row')
        if (formRow) {formRow.remove()}
      }
    })

    const submitBtn = document.createElement('button')
    submitBtn.type = 'button'
    submitBtn.className = 'comment-form-submit'
    submitBtn.textContent = 'Submit'
    submitBtn.addEventListener('click', function () {
      const text = textarea.value.trim()
      if (!text) {return}
      postComment(sel.file, sel.from, sel.to, text, null, function () {
        if (isDocumentsPage) {
          const formEl = document.querySelector('.doc-comment-form')
          if (formEl) {formEl.remove()}
        } else {
          const formRow = document.querySelector('.comment-form-row')
          if (formRow) {formRow.remove()}
        }
      })
    })

    btnRow.appendChild(cancelBtn)
    btnRow.appendChild(submitBtn)
    container.appendChild(label)
    container.appendChild(textarea)
    container.appendChild(btnRow)

    if (isDocumentsPage) {
      // On documents page: insert form as a div after the last selected block
      const formDiv = document.createElement('div')
      formDiv.className = 'doc-comment-form'
      formDiv.appendChild(container)
      lastEl.parentNode.insertBefore(formDiv, lastEl.nextSibling)
    } else {
      // On code pages: insert form as a table row
      const formRow = document.createElement('tr')
      formRow.className = 'comment-form-row'
      const formCell = document.createElement('td')
      formCell.colSpan = 2
      formCell.className = 'comment-form-cell'
      formCell.appendChild(container)
      formRow.appendChild(formCell)
      lastEl.parentNode.insertBefore(formRow, lastEl.nextSibling)
    }

    textarea.focus({ preventScroll: true })

    // Scroll the first selected element to the top, accounting for the sticky header
    const firstSelectedSelector = isDocumentsPage
      ? '.doc-block.block-selected'
      : '.code-table tr.selected'
    const firstSelected = document.querySelector(firstSelectedSelector)
    if (firstSelected) {
      const topbar = document.querySelector('.topbar')
      const headerHeight = topbar ? topbar.getBoundingClientRect().height : 0
      const targetY =
        firstSelected.getBoundingClientRect().top +
        window.scrollY -
        headerHeight -
        8
      window.scrollTo({ top: targetY })
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Event Listeners                                                    */
  /* ------------------------------------------------------------------ */

  document.addEventListener('walkthroughselectionchange', function () {
    const sel = window.walkthroughSelection
    if (sel) {
      positionAddButton(sel)
    } else {
      hideAddButton()
    }
  })

  // Add button click handler (delegated since button is created lazily)
  document.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('comment-add-btn')) {
      const sel = window.walkthroughSelection
      if (sel) {
        showCommentForm(sel)
      }
    }
  })

  // Hide the add-comment button on scroll
  window.addEventListener(
    'scroll',
    function () {
      hideAddButton()
    },
    { passive: true },
  )

  // Re-render comments when tabs change on documents page
  document.addEventListener('doctabchange', function () {
    renderAllComments()
  })

  function init() {
    renderDemoBanner()
    renderAuthUi()
    fetchComments()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
