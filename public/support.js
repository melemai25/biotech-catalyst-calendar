/**
 * Support footer.
 *
 * Self-contained on purpose: it injects its own markup and its own styles, so
 * adding it to a page is one script tag and nothing else in the repo has to
 * change. That also means it cannot break the app — if this file throws, the
 * page is exactly as it was.
 *
 * It lives OUTSIDE #root, so app.js re-rendering a tab never wipes it.
 *
 * ---------------------------------------------------------------------------
 * TO TURN IT ON: paste your Stripe Payment Link below.
 * ---------------------------------------------------------------------------
 * While SUPPORT_URL is the placeholder, this file renders nothing at all. That
 * is deliberate: the script can ship and deploy before the Stripe account
 * exists, without a dead button going live.
 */
(function () {
  'use strict';

  var SUPPORT_URL = 'https://buy.stripe.com/fZu4gt17waui1Ee9Ltasg00';

  /** One honest line about where the money goes. Keep it concrete. */
  var BLURB = 'Biolyst is free and has no ads. Support covers the domain, data costs, and maintenance. Thank You!';

  /* Not a nonprofit, so this has to be said plainly rather than implied away. */
  var SMALLPRINT = 'Biolyst is not a registered charity and contributions are not tax-deductible.';

  if (!/^https:\/\//.test(SUPPORT_URL)) return;   // placeholder, or not https

  var CSS = [
    /* box-sizing is set here rather than inherited from the page's reset. This
       file is meant to drop into any page, and without it the padding is added
       OUTSIDE max-width, so the footer renders 42px wider than it claims. */
    '.blyst-support,.blyst-support *{box-sizing:border-box;}',
    '.blyst-support{',
      'max-width:1180px;margin:8px auto 28px;padding:18px 20px;',
      'display:flex;align-items:center;justify-content:space-between;gap:18px;',
      'flex-wrap:wrap;',
      'background:var(--surface,#fff);border:1px solid var(--line,#DCE8EC);',
      'border-radius:var(--r-lg,16px);box-shadow:var(--shadow-sm,0 1px 2px rgba(22,52,63,.05));',
      'font-family:inherit;',
    '}',
    '.blyst-support-text{min-width:0;flex:1 1 320px;}',
    '.blyst-support-blurb{',
      'margin:0;font-size:14px;line-height:1.45;color:var(--ink,#16343F);',
    '}',
    '.blyst-support-small{',
      'margin:5px 0 0;font-size:11.5px;line-height:1.4;color:var(--ink-faint,#8CA4AE);',
    '}',
    '.blyst-support-btn{',
      'flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;',
      'padding:10px 18px;border-radius:var(--r-pill,999px);',
      'background:var(--teal,#0E8C97);color:#fff;',
      'font-size:14px;font-weight:600;text-decoration:none;',
      'transition:background .15s ease;',
    '}',
    '.blyst-support-btn:hover{background:var(--teal-dark,#0A6E77);}',
    '.blyst-support-btn:focus-visible{outline:2px solid var(--teal-dark,#0A6E77);outline-offset:2px;}',
    '.blyst-support-btn svg{flex:0 0 auto;}',
    /* minmax-style guard: at phone width the row stacks and the button goes full
       width, rather than the text squeezing to one word per line. */
    '@media (max-width:620px){',
      '.blyst-support{margin:4px 12px 20px;padding:16px;gap:14px;}',
      '.blyst-support-btn{width:100%;justify-content:center;}',
    '}'
  ].join('');

  function mount() {
    if (document.querySelector('.blyst-support')) return;   // never twice

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var footer = document.createElement('footer');
    footer.className = 'blyst-support';

    var text = document.createElement('div');
    text.className = 'blyst-support-text';

    var blurb = document.createElement('p');
    blurb.className = 'blyst-support-blurb';
    blurb.textContent = BLURB;

    var small = document.createElement('p');
    small.className = 'blyst-support-small';
    small.textContent = SMALLPRINT;

    text.appendChild(blurb);
    text.appendChild(small);

    var a = document.createElement('a');
    a.className = 'blyst-support-btn';
    a.href = SUPPORT_URL;
    // Opens Stripe's own hosted page. noopener/noreferrer because the new tab
    // has no business holding a handle on this one.
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', 'Support Biolyst (opens Stripe in a new tab)');

    // Inline, so there is no second request and nothing to 404.
    a.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.1" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8' +
      'l8.8 8.8 8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/></svg>' +
      '<span>Support Us</span>';

    footer.appendChild(text);
    footer.appendChild(a);
    document.body.appendChild(footer);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
