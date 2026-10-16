/**
 * Site footer: "Support Us" and "Help us improve".
 *
 * Self-contained on purpose: it injects its own markup and its own styles, so
 * adding it to a page is one script tag and nothing else in the repo changes.
 * If this file throws, the page is exactly as it was.
 * Styling was done with AI
 * It mounts OUTSIDE #root, so app.js re-rendering a tab never wipes it.
 *
 * ===========================================================================
 * CONFIGURE BELOW. Each feature is independent — set one, both, or neither.
 * A feature whose setting is still a placeholder simply does not render, so
 * this file is safe to commit and deploy before either account exists.
 * ===========================================================================
 */
(function () {
  'use strict';

  /* -- 1. Donations ------------------------------------------------------ */
     var SUPPORT_URL = 'https://buy.stripe.com/fZu4gt17waui1Ee9Ltasg00';

  /* -- 2. Feedback ------------------------------------------------------- */
 
  var FEEDBACK_ENDPOINT = 'https://formspree.io/f/xyeklall';
  
  /* for webhook which we aren't using*/
  var FEEDBACK_EXTRA = {};

  /* --Supprt-------------------------------------------------------------- */
  var BLURB = 'Biolyst.org is committed to staying ad-free and subscription-free. Your support helps us keep the lights on. Thank you!';
  var SMALLPRINT = 'Biolyst.org is not a registered charity and contributions are not tax-deductible.';

  var MAX_CHARS  = 4000;
  var THROTTLE_MS = 60 * 1000;          // one message a minute, per browser

  var hasSupport  = /^https:\/\//.test(SUPPORT_URL);
  var hasFeedback = /^https:\/\//.test(FEEDBACK_ENDPOINT);
  if (!hasSupport && !hasFeedback) return;

  /* ===================================================================== *
   * Styles
   * ===================================================================== */
  var CSS = [
    /* box-sizing is set here rather than inherited from the page's reset.
       Without it the padding is added OUTSIDE max-width and the footer
       renders ~42px wider than it claims. */
    '.blyst,.blyst *{box-sizing:border-box;}',

    '.blyst-footer{',
      'max-width:1180px;margin:8px auto 28px;padding:18px 20px;',
      'display:flex;align-items:center;justify-content:space-between;gap:18px;',
      'flex-wrap:wrap;background:var(--surface,#fff);',
      'border:1px solid var(--line,#DCE8EC);border-radius:var(--r-lg,16px);',
      'box-shadow:var(--shadow-sm,0 1px 2px rgba(22,52,63,.05));font-family:inherit;',
    '}',
    '.blyst-text{min-width:0;flex:1 1 300px;}',
    '.blyst-blurb{margin:0;font-size:14px;line-height:1.45;color:var(--ink,#16343F);}',
    '.blyst-small{margin:5px 0 0;font-size:11.5px;line-height:1.4;color:var(--ink-faint,#8CA4AE);}',
    '.blyst-actions{flex:0 0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',

    '.blyst-btn{',
      'display:inline-flex;align-items:center;gap:7px;padding:10px 18px;',
      'border-radius:var(--r-pill,999px);font-size:14px;font-weight:600;',
      'text-decoration:none;cursor:pointer;font-family:inherit;',
      'border:1px solid transparent;transition:background .15s ease,border-color .15s ease;',
    '}',
    '.blyst-btn-primary{background:var(--teal,#0E8C97);color:#fff;}',
    '.blyst-btn-primary:hover{background:var(--teal-dark,#0A6E77);}',
    '.blyst-btn-ghost{',
      'background:transparent;color:var(--ink-soft,#5A7784);',
      'border-color:var(--line,#DCE8EC);',
    '}',
    '.blyst-btn-ghost:hover{background:var(--surface-soft,#F6FAFB);color:var(--ink,#16343F);}',
    '.blyst-btn:focus-visible{outline:2px solid var(--teal-dark,#0A6E77);outline-offset:2px;}',
    '.blyst-btn[disabled]{opacity:.55;cursor:default;}',

    /* ---- modal ---- */
    '.blyst-scrim{',
      'position:fixed;inset:0;z-index:9000;background:rgba(22,52,63,.45);',
      'display:flex;align-items:center;justify-content:center;padding:20px;',
    '}',
    '.blyst-modal{',
      'width:100%;max-width:480px;max-height:calc(100vh - 40px);overflow:auto;',
      'background:var(--surface,#fff);border-radius:var(--r-lg,16px);',
      'box-shadow:var(--shadow-lg,0 8px 24px rgba(22,52,63,.10),0 24px 56px rgba(22,52,63,.10));',
      'padding:22px;font-family:inherit;color:var(--ink,#16343F);',
    '}',
    '.blyst-modal h2{margin:0 0 4px;font-size:17px;font-weight:700;}',
    '.blyst-lede{margin:0 0 16px;font-size:13px;line-height:1.5;color:var(--ink-soft,#5A7784);}',
    '.blyst-label{display:block;font-size:12.5px;font-weight:600;margin:0 0 5px;}',
    '.blyst-opt{font-weight:400;color:var(--ink-faint,#8CA4AE);}',
    '.blyst-field{',
      'width:100%;padding:10px 12px;font-size:14px;font-family:inherit;color:inherit;',
      'background:var(--surface-soft,#F6FAFB);border:1px solid var(--line,#DCE8EC);',
      'border-radius:var(--r-sm,9px);',
    '}',
    '.blyst-field:focus{outline:2px solid var(--teal,#0E8C97);outline-offset:-1px;border-color:transparent;}',
    'textarea.blyst-field{min-height:120px;resize:vertical;line-height:1.5;}',
    '.blyst-row{margin:0 0 14px;}',
    '.blyst-note{margin:0 0 16px;font-size:11.5px;line-height:1.45;color:var(--ink-faint,#8CA4AE);}',
    '.blyst-modal-actions{display:flex;justify-content:flex-end;gap:10px;}',
    '.blyst-status{margin:0 0 12px;font-size:13px;line-height:1.45;}',
    '.blyst-status-err{color:var(--rose,#D4635F);}',
    '.blyst-done{text-align:center;padding:14px 0 4px;}',
    '.blyst-done p{margin:0 0 18px;font-size:14px;line-height:1.5;}',
    /* The honeypot must be reachable by a bot parsing the DOM but invisible
       and unreachable to a person — display:none is skipped by some bots. */
    '.blyst-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}',

    '@media (max-width:620px){',
      '.blyst-footer{margin:4px 12px 20px;padding:16px;gap:14px;}',
      '.blyst-actions{width:100%;}',
      '.blyst-actions .blyst-btn{flex:1 1 auto;justify-content:center;}',
      '.blyst-scrim{padding:0;align-items:flex-end;}',
      '.blyst-modal{max-width:none;border-radius:var(--r-lg,16px) var(--r-lg,16px) 0 0;max-height:88vh;}',
    '}'
  ].join('');

  /* ===================================================================== *
   * Helpers
   * ===================================================================== */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* localStorage throws in private windows and when site data is blocked, so
     every access is guarded. A failure here must never block a submission. */
  function lastSentAt() {
    try { return parseInt(localStorage.getItem('blyst:lastFeedback') || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function markSent() {
    try { localStorage.setItem('blyst:lastFeedback', String(Date.now())); } catch (e) { /* fine */ }
  }

  var HEART =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    'focusable="false"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 ' +
    '7.8l8.8 8.8 8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/></svg>';

  /* ===================================================================== *
   * Feedback modal
   * ===================================================================== */
  function openFeedback(trigger) {
    var previouslyFocused = trigger || document.activeElement;

    var scrim = el('div', 'blyst blyst-scrim');
    var modal = el('div', 'blyst-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'blyst-fb-title');

    var title = el('h2', null, 'Give Feedback');
    title.id = 'blyst-fb-title';
    var lede = el('p', 'blyst-lede',
      "Found something wrong, missing or confusing? Or have an idea that would make our site more useful? Let us know - we'd love to hear from you!");

    var form = document.createElement('form');
    form.noValidate = true;

    // message
    var rowMsg = el('div', 'blyst-row');
    var labMsg = el('label', 'blyst-label', 'Your message');
    labMsg.htmlFor = 'blyst-fb-msg';
    var msg = document.createElement('textarea');
    msg.className = 'blyst-field';
    msg.id = 'blyst-fb-msg';
    msg.name = 'message';
    msg.maxLength = MAX_CHARS;
    msg.required = true;
    msg.placeholder = 'A wrong date, a company we are missing, something that did not work…';
    rowMsg.appendChild(labMsg); rowMsg.appendChild(msg);

    // optional email
    var rowMail = el('div', 'blyst-row');
    var labMail = el('label', 'blyst-label', 'Email ');
    labMail.htmlFor = 'blyst-fb-mail';
    labMail.appendChild(el('span', 'blyst-opt', '— optional, only if you want a reply'));
    var mail = document.createElement('input');
    mail.className = 'blyst-field';
    mail.id = 'blyst-fb-mail';
    mail.type = 'email';
    mail.name = 'email';
    mail.autocomplete = 'email';
    rowMail.appendChild(labMail); rowMail.appendChild(mail);

    // honeypot — a bot fills every field it finds; a person never sees this
    var hp = document.createElement('div');
    hp.className = 'blyst-hp';
    hp.setAttribute('aria-hidden', 'true');
    var hpIn = document.createElement('input');
    hpIn.type = 'text'; hpIn.name = 'website'; hpIn.tabIndex = -1;
    hpIn.autocomplete = 'off';
    hp.appendChild(hpIn);

    // Disclosed, not silent: say what gets attached.
    var note = el('p', 'blyst-note',
      'Sends your message and the page you are on. Nothing else, and no tracking.');

    var status = el('p', 'blyst-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.display = 'none';

    var actions = el('div', 'blyst-modal-actions');
    var cancel = el('button', 'blyst-btn blyst-btn-ghost', 'Cancel');
    cancel.type = 'button';
    var send = el('button', 'blyst-btn blyst-btn-primary', 'Send');
    send.type = 'submit';
    actions.appendChild(cancel); actions.appendChild(send);

    form.appendChild(rowMsg); form.appendChild(rowMail); form.appendChild(hp);
    form.appendChild(note); form.appendChild(status); form.appendChild(actions);
    modal.appendChild(title); modal.appendChild(lede); modal.appendChild(form);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);

    msg.focus();

    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      // Keep focus inside the dialog, so Tab cannot land on the page behind it.
      var f = modal.querySelectorAll('textarea,input:not([tabindex="-1"]),button');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);

    cancel.addEventListener('click', close);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });

    function fail(text) {
      status.className = 'blyst-status blyst-status-err';
      status.textContent = text;
      status.style.display = '';
      send.disabled = false;
      send.textContent = 'Send';
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      status.style.display = 'none';

      if (hpIn.value) { close(); return; }        // a bot: accept silently, send nothing

      var body = msg.value.trim();
      if (!body) { fail('Please write a message first.'); msg.focus(); return; }
      if (mail.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.value.trim())) {
        fail('That email address does not look right. Leave it blank if you prefer.');
        mail.focus(); return;
      }
      if (Date.now() - lastSentAt() < THROTTLE_MS) {
        fail('You just sent one. Give it a minute, then send again.'); return;
      }

      send.disabled = true;
      send.textContent = 'Sending…';

      var payload = { message: body, page: location.href };
      if (mail.value.trim()) payload.email = mail.value.trim();
      for (var k in FEEDBACK_EXTRA) {
        if (Object.prototype.hasOwnProperty.call(FEEDBACK_EXTRA, k)) payload[k] = FEEDBACK_EXTRA[k];
      }

      fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        markSent();
        // Replace the form rather than clearing it, so there is no doubt it sent.
        modal.innerHTML = '';
        var done = el('div', 'blyst-done');
        var h = el('h2', null, 'Thank you');
        h.id = 'blyst-fb-title';
        done.appendChild(h);
        done.appendChild(el('p', null,
          'Your message is on its way. If you left an email, we may write back.'));
        var ok = el('button', 'blyst-btn blyst-btn-primary', 'Close');
        ok.type = 'button';
        ok.addEventListener('click', close);
        done.appendChild(ok);
        modal.appendChild(done);
        ok.focus();
      }).catch(function () {
        // The text stays in the box — losing what someone typed is unforgivable.
        fail('That did not send. Check your connection and try again.');
      });
    });
  }

  /* ===================================================================== *
   * Footer
   * ===================================================================== */
  function mount() {
    if (document.querySelector('.blyst-footer')) return;      // never twice

    var style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var footer = el('footer', 'blyst blyst-footer');

    var text = el('div', 'blyst-text');
    text.appendChild(el('p', 'blyst-blurb', hasSupport ? BLURB
      : 'Biolyst is free and has no ads.'));
    if (hasSupport) text.appendChild(el('p', 'blyst-small', SMALLPRINT));

    var actions = el('div', 'blyst-actions');

    if (hasFeedback) {
      var fb = el('button', 'blyst-btn blyst-btn-ghost', 'Help us improve');
      fb.type = 'button';
      fb.addEventListener('click', function () { openFeedback(fb); });
      actions.appendChild(fb);
    }

    if (hasSupport) {
      var a = el('a', 'blyst-btn blyst-btn-primary');
      a.href = SUPPORT_URL;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';     // the new tab gets no handle on this one
      a.setAttribute('aria-label', 'Support Biolyst (opens Stripe in a new tab)');
      a.innerHTML = HEART + '<span>Support Us</span>';
      actions.appendChild(a);
    }

    footer.appendChild(text);
    footer.appendChild(actions);
    document.body.appendChild(footer);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
