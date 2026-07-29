/**
 * Sign-in page for an encrypted walkthrough.
 *
 * A reader who navigates to a private walkthrough without a valid
 * reader cookie gets this page with the refusal's status code, not
 * a bare 401 body: the response is both the machine answer and the
 * place a human continues from.
 *
 * It drives the existing magic-code flow — `POST /api/auth/request`
 * mails a six-digit code, `POST /:slug/api/auth/session` trades the
 * code for the slug's reader cookie — then reloads, at which point
 * the browser sends the cookie and the walkthrough renders. The
 * session token that comes back on the same response is stashed
 * under the comment client's localStorage keys, so the reader lands
 * on the page already able to comment.
 *
 * The inline script is plain browser script: no `import`, no bare
 * specifiers, nothing that needs a module context.
 */

/**
 * LocalStorage keys the comment client reads (assets/comment-client.js).
 * Sign-in writes them so a reader does not authenticate twice.
 */
const TOKEN_STORAGE_KEY = 'meander:auth:v1:token'

const EMAIL_STORAGE_KEY = 'meander:auth:v1:email'

export type LoginPageConfig = {
  /**
   * The refusal that sent the reader here, rendered verbatim so an
   * operator debugging a locked-out domain sees the real reason.
   */
  reason: string
  slug: string
}

/**
 * Escape text for interpolation into HTML body content or a
 * double-quoted attribute.
 */
export function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Render the sign-in page for `slug`.
 */
export function renderLoginPage(config: LoginPageConfig): string {
  const cfg = { __proto__: null, ...config } as LoginPageConfig
  const slug = escapeHtmlText(cfg.slug)
  const reason = escapeHtmlText(cfg.reason)
  /* JSON.stringify produces a safe JS string literal, and the
   * closing-tag split keeps a slug containing "</script" from
   * ending the element early. Slugs are [a-z0-9-] today; the
   * escaping does not depend on that staying true. */
  const slugLiteral = JSON.stringify(cfg.slug).replaceAll('</', '<\\/')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in — ${slug}</title>
<link rel="stylesheet" href="/meander.css">
<style>
.meander-login { margin: 0 auto; max-width: 26rem; padding: 3rem 1rem; }
.meander-login h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
.meander-login p { line-height: 1.5; margin: 0 0 1rem; }
.meander-login label { display: block; font-weight: 600; margin: 0 0 0.25rem; }
.meander-login input { box-sizing: border-box; font: inherit; margin: 0 0 0.75rem; padding: 0.5rem; width: 100%; }
.meander-login button { font: inherit; padding: 0.5rem 1rem; }
.meander-login .meander-login-note { font-size: 0.875rem; opacity: 0.8; }
.meander-login [hidden] { display: none; }
</style>
</head>
<body>
<main class="meander-login">
<h1>${slug} is a private walkthrough</h1>
<p>Sign in with your work email to read it. We mail you a six-digit code; it is good for ten minutes.</p>
<p class="meander-login-note">Access refused: ${reason}</p>
<form id="meander-login-form" autocomplete="on">
  <label for="meander-login-email">Email</label>
  <input id="meander-login-email" name="email" type="email" required autocomplete="email">
  <div id="meander-login-code-row" hidden>
    <label for="meander-login-code">Six-digit code</label>
    <input id="meander-login-code" name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code">
  </div>
  <button id="meander-login-submit" type="submit">Email me a code</button>
</form>
<p id="meander-login-status" class="meander-login-note" role="status" aria-live="polite"></p>
</main>
<script>
(function () {
  var slug = ${slugLiteral}
  var form = document.getElementById('meander-login-form')
  var emailInput = document.getElementById('meander-login-email')
  var codeRow = document.getElementById('meander-login-code-row')
  var codeInput = document.getElementById('meander-login-code')
  var submit = document.getElementById('meander-login-submit')
  var status = document.getElementById('meander-login-status')
  var stage = 'request'

  function say(message) {
    status.textContent = message
  }

  function post(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {}
        })
        .then(function (body) {
          return { ok: res.ok, body: body }
        })
    })
  }

  function requestCode(email) {
    return post('/api/auth/request', { email: email }).then(function (result) {
      if (!result.ok) {
        say(result.body.error || 'Could not send a code.')
        return
      }
      stage = 'verify'
      codeRow.hidden = false
      submit.textContent = 'Sign in'
      codeInput.focus()
      say('Code sent. Check ' + email + '.')
    })
  }

  function signIn(email, code) {
    return post('/' + encodeURIComponent(slug) + '/api/auth/session', {
      email: email,
      code: code,
    }).then(function (result) {
      if (!result.ok) {
        say(result.body.error || 'Sign-in failed.')
        return
      }
      try {
        localStorage.setItem(${JSON.stringify(TOKEN_STORAGE_KEY)}, result.body.token || '')
        localStorage.setItem(${JSON.stringify(EMAIL_STORAGE_KEY)}, result.body.email || email)
      } catch (e) {
        /* A browser with storage disabled still gets the cookie —
         * only the comment composer's pre-fill is lost. */
      }
      say('Signed in. Loading the walkthrough…')
      location.reload()
    })
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault()
    var email = emailInput.value.trim()
    if (!email) {
      say('Enter your email address.')
      return
    }
    submit.disabled = true
    var pending =
      stage === 'request' ? requestCode(email) : signIn(email, codeInput.value.trim())
    pending
      .catch(function () {
        say('Network error. Try again.')
      })
      .then(function () {
        submit.disabled = false
      })
  })
})()
</script>
</body>
</html>`
}
