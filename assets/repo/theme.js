/* Theme toggle — a two-state light/dark button.
 *
 * Two states in the UI, three in storage: the button only ever
 * shows "light" or "dark", but the stored preference can also be
 * absent, which means "follow the OS".
 *
 * Synchronous bits (resolve stored pref, apply <html data-theme>,
 * install system-prefs observer) run immediately at load so there
 * is no flash of light theme on dark-preferring systems.
 *
 * The DOM-building bit (topbar toggle button) is registered as a
 * boot phase so it runs after DOMContentLoaded — that's when
 * `.topbar` exists to host the button.
 */
'use strict'
;(() => {
  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  const THEME_KEY = 'meander:pages:theme'
  const { storageGet, storageSet } = ns

  const OUTLINE =
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  const SOLID = 'fill="currentColor"'
  const THEME_ICONS = {
    light: {
      label: 'Light',
      style: 'outline',
      path: `
    <path class="theme-ray" d="M12 1V3"/>
    <path class="theme-ray" d="M18.36 5.64L19.78 4.22"/>
    <path class="theme-ray" d="M21 12H23"/>
    <path class="theme-ray" d="M18.36 18.36L19.78 19.78"/>
    <path class="theme-ray" d="M12 21V23"/>
    <path class="theme-ray" d="M4.22 19.78L5.64 18.36"/>
    <path class="theme-ray" d="M1 12H3"/>
    <path class="theme-ray" d="M4.22 4.22L5.64 5.64"/>
    <path d="M12 17C14.7614 17 17 14.7614 17 12C17 9.23858 14.7614 7 12 7C9.23858 7 7 9.23858 7 12C7 14.7614 9.23858 17 12 17Z"/>
  `,
    },
    dark: {
      label: 'Dark',
      style: 'solid',
      path: `
    <path d="M19 14.79C18.8427 16.4922 18.2039 18.1144 17.1582 19.4668C16.1126 20.8192 14.7035 21.8458 13.0957 22.4265C11.4879 23.0073 9.74798 23.1181 8.0795 22.7461C6.41102 22.3741 4.88299 21.5345 3.67423 20.3258C2.46546 19.117 1.62594 17.589 1.25391 15.9205C0.881876 14.252 0.992717 12.5121 1.57346 10.9043C2.1542 9.29651 3.18083 7.88737 4.53321 6.84175C5.8856 5.79614 7.5078 5.15731 9.21 5C8.21341 6.34827 7.73385 8.00945 7.85853 9.68141C7.98322 11.3534 8.70386 12.9251 9.8894 14.1106C11.0749 15.2961 12.6466 16.0168 14.3186 16.1415C15.9906 16.2662 17.6517 15.7866 19 14.79Z"/>
    <path class="theme-star" d="M18.3707 1C18.3707 3.22825 16.2282 5.37069 14 5.37069C16.2282 5.37069 18.3707 7.51313 18.3707 9.74138C18.3707 7.51313 20.5132 5.37069 22.7414 5.37069C20.5132 5.37069 18.3707 3.22825 18.3707 1Z"/>
  `,
    },
  }
  const themeIconSvg = (pref, extraClass = '') => {
    const { style, path } = THEME_ICONS[pref]
    const attrs = style === 'solid' ? SOLID : OUTLINE
    const classAttr = extraClass ? ` class="${extraClass}"` : ''
    return `<svg${classAttr} viewBox="0 0 24 24" aria-hidden="true" ${attrs}>${path}</svg>`
  }

  const readStoredTheme = () => {
    const t = storageGet(THEME_KEY)
    return t === 'dark' || t === 'light' ? t : 'system'
  }
  /* storageSet removes the key on `null` only — passing `undefined`
   * stores the literal string "undefined", which leaves a stale key
   * behind instead of returning the reader to OS-following.
   */
  const persistTheme = theme =>
    // oxlint-disable-next-line socket/prefer-undefined-over-null -- storageSet's contract is `null ⇒ removeItem`; `undefined` takes the setItem branch and stores the string "undefined".
    storageSet(THEME_KEY, theme === 'system' ? null : theme)
  const systemPrefersDark = () =>
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  const systemTheme = () => (systemPrefersDark() ? 'dark' : 'light')
  const resolveTheme = pref => (pref === 'system' ? systemTheme() : pref)
  const applyTheme = theme => {
    document.documentElement.setAttribute('data-theme', theme)
  }

  /* Apply stored or system-preferred theme synchronously to avoid a
   * flash of light theme on dark-preferring systems.
   */
  applyTheme(resolveTheme(readStoredTheme()))

  if (window.matchMedia) {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    mql.addEventListener('change', event => {
      if (readStoredTheme() === 'system') {
        applyTheme(event.matches ? 'dark' : 'light')
      }
    })
  }

  const installThemeToggle = () => {
    if (document.querySelector('.theme-toggle')) {
      return
    }
    const topbar = document.querySelector('.topbar')
    if (!topbar) {
      return
    }
    let host = topbar.querySelector('.topbar-actions')
    if (!host) {
      host = document.createElement('div')
      host.className = 'topbar-actions'
      topbar.appendChild(host)
    }

    const icons = Object.keys(THEME_ICONS)
      .map(p => themeIconSvg(p, `theme-icon theme-icon-${p}`))
      .join('\n        ')

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'theme-toggle'
    btn.innerHTML = icons

    /* The button always offers the opposite of what is on screen,
     * so both the icon and the label are derived from the RESOLVED
     * theme rather than from the stored preference — with nothing
     * stored, the stored value ("system") names no icon.
     */
    const render = () => {
      const resolved = resolveTheme(readStoredTheme())
      const label = `Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`
      btn.setAttribute('data-resolved', resolved)
      btn.setAttribute('aria-label', label)
      btn.title = label
    }

    btn.addEventListener('click', () => {
      const target =
        resolveTheme(readStoredTheme()) === 'dark' ? 'light' : 'dark'
      /* Compare the TARGET against the OS preference, not against
       * the stored value. When the two agree we drop the key and go
       * back to following the OS, which is how a second press
       * returns the reader to OS-following without a third control.
       * It also keeps the button live when the OS flipped underneath
       * a stored override: the target still differs from what is on
       * screen, so the press always visibly changes something.
       */
      persistTheme(target === systemTheme() ? 'system' : target)
      applyTheme(target)
      render()
    })

    render()
    host.prepend(btn)
  }

  ns.onReady(installThemeToggle)
})()
