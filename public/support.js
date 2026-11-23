/*
 * Footer with Support Us + Give Feedback.
 * Injects its own html and css, mounts outside #root so app.js renders don't wipe it.
 * Styling was done with AI
 * A feature with a blank/placeholder url just doesn't render.
 */
(function () {
  'use strict';

  /* config */

  var SUPPORT_URL       = 'https://buy.stripe.com/fZu4gt17waui1Ee9Ltasg00';
  var FEEDBACK_ENDPOINT = 'https://formspree.io/f/xyeklall';
  var MAX_CHARS         = 4000;
  var THROTTLE_MS       = 60 * 1000;   // 1 per minute per browser

  var hasSupport  = /^https:\/\//.test(SUPPORT_URL);
  var hasFeedback = /^https:\/\//.test(FEEDBACK_ENDPOINT);
  if (!hasSupport && !hasFeedback) return;

  /* text */

  var TEXT = {
    blurb:        'Biolyst is ad-free and subscription-free. Support covers the domain, data, and general upkeep.',
    blurbNoStripe:'Biolyst is free and has no ads.',
    smallprint:   'Biolyst is not a registered charity and contributions are not tax-deductible.',
    feedbackBtn:  'Give Feedback',
    supportBtn:   'Support Us',
    modalTitle:   'Give Feedback',
    modalLede:    "Found something wrong, missing or confusing? Or have an idea that would make our site more useful? Let us know - we'd love to hear from you!",
    msgLabel:     'Your message',
    msgHint:      'A wrong date, a recommendation, something not working…',
    mailLabel:    'Email ',
    mailHint:     '— optional, only if you want a reply',
    privacy:      'Sends your message and the page you are on. Nothing else, and no tracking.',
    thanksTitle:  'Thank you',
    thanksBody:   'Your message is on its way. If you left an email, we may write back.',
    errEmpty:     'Please write a message first.',
    errEmail:     'That email address does not look right. Leave it blank if you prefer.',
    errThrottle:  'You just sent one. Give it a minute, then send again.',
    errSend:      'That did not send. Check your connection and try again.'
  };

  /* styles */

  var CSS = [
    /* own box-sizing, otherwise the footer ends up ~42px wider than max-width */
    '.blyst,.blyst *{box-sizing:border-box;}',

    /* footer */
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

    /* buttons */
    '.blyst-btn{',
      'display:inline-flex;align-items:center;gap:7px;padding:10px 18px;',
      'border-radius:var(--r-pill,999px);font-size:14px;font-weight:600;',
      'text-decoration:none;cursor:pointer;font-family:inherit;',
      'border:1px solid transparent;transition:background .15s ease,border-color .15s ease;',
    '}',
    '.blyst-btn-primary{background:var(--teal,#0E8C97);color:#fff;}',
    '.blyst-btn-primary:hover{background:var(--teal-dark,#0A6E77);}',
    '.blyst-btn-ghost{background:transparent;color:var(--ink-soft,#5A7784);border-color:var(--line,#DCE8EC);}',
    '.blyst-btn-ghost:hover{background:var(--surface-soft,#F6FAFB);color:var(--ink,#16343F);}',
    '.blyst-btn:focus-visible{outline:2px solid var(--teal-dark,#0A6E77);outline-offset:2px;}',
    '.blyst-btn[disabled]{opacity:.55;cursor:default;}',

    /* modal */
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
    '.blyst-modal-actions{display:flex;justify-content:flex-end;gap:10px;}',

    /* form */
    '.blyst-row{margin:0 0 14px;}',
    '.blyst-label{display:block;font-size:12.5px;font-weight:600;margin:0 0 5px;}',
    '.blyst-opt{font-weight:400;color:var(--ink-faint,#8CA4AE);}',
    '.blyst-field{',
      'width:100%;padding:10px 12px;font-size:14px;font-family:inherit;color:inherit;',
      'background:var(--surface-soft,#F6FAFB);border:1px solid var(--line,#DCE8EC);',
      'border-radius:var(--r-sm,9px);',
    '}',
    '.blyst-field:focus{outline:2px solid var(--teal,#0E8C97);outline-offset:-1px;border-color:transparent;}',
    'textarea.blyst-field{min-height:120px;resize:vertical;line-height:1.5;}',
    '.blyst-note{margin:0 0 16px;font-size:11.5px;line-height:1.45;color:var(--ink-faint,#8CA4AE);}',
    '.blyst-status{margin:0 0 12px;font-size:13px;line-height:1.45;}',
    '.blyst-status-err{color:var(--rose,#D4635F);}',
    '.blyst-done{text-align:center;padding:14px 0 4px;}',
    '.blyst-done p{margin:0 0 18px;font-size:14px;line-height:1.5;}',
    /* honeypot: offscreen instead of display:none, some bots skip hidden fields */
    '.blyst-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}',

    /* phones */
    '@media (max-width:620px){',
      '.blyst-footer{margin:4px 12px 20px;padding:16px;gap:14px;}',
      '.blyst-actions{width:100%;}',
      '.blyst-actions .blyst-btn{flex:1 1 auto;justify-content:center;}',
      '.blyst-scrim{padding:0;align-items:flex-end;}',
      '.blyst-modal{max-width:none;border-radius:var(--r-lg,16px) var(--r-lg,16px) 0 0;max-height:88vh;}',
    '}'
  ].join('');

  var HEART =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    'focusable="false"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 ' +
    '7.8l8.8 8.8 8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/></svg>';

  /* helpers */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(cls, text, type) {
    var b = el('button', 'blyst-btn ' + cls, text);
    b.type = type || 'button';
    return b;
  }

  /* localStorage throws in private mode, never let that block a send */
  function lastSentAt() {
    try { return parseInt(localStorage.getItem('blyst:lastFeedback') || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function markSent() {
    try { localStorage.setItem('blyst:lastFeedback', String(Date.now())); } catch (e) {}
  }

  function isEmail(s) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
  }

  /* footer */

  function mount() {
    if (document.querySelector('.blyst-footer')) return;

    var style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var text = el('div', 'blyst-text');
    text.appendChild(el('p', 'blyst-blurb', hasSupport ? TEXT.blurb : TEXT.blurbNoStripe));
    if (hasSupport) text.appendChild(el('p', 'blyst-small', TEXT.smallprint));

    var actions = el('div', 'blyst-actions');

    if (hasFeedback) {
      var fb = button('blyst-btn-ghost', TEXT.feedbackBtn);
      fb.addEventListener('click', function () { openFeedback(fb); });
      actions.appendChild(fb);
    }

    if (hasSupport) {
      var a = el('a', 'blyst-btn blyst-btn-primary');
      a.href = SUPPORT_URL;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', 'Support Biolyst (opens Stripe in a new tab)');
      a.innerHTML = HEART + '<span>' + TEXT.supportBtn + '</span>';
      actions.appendChild(a);
    }

    var footer = el('footer', 'blyst blyst-footer');
    footer.appendChild(text);
    footer.appendChild(actions);
    document.body.appendChild(footer);
  }

  /* feedback modal */

  function buildForm() {
    var form = document.createElement('form');
    form.noValidate = true;

    // message
    var rowMsg = el('div', 'blyst-row');
    var labMsg = el('label', 'blyst-label', TEXT.msgLabel);
    labMsg.htmlFor = 'blyst-fb-msg';
    var msg = document.createElement('textarea');
    msg.className = 'blyst-field';
    msg.id = 'blyst-fb-msg';
    msg.name = 'message';
    msg.maxLength = MAX_CHARS;
    msg.required = true;
    msg.placeholder = TEXT.msgHint;
    rowMsg.appendChild(labMsg);
    rowMsg.appendChild(msg);

    // optional email
    var rowMail = el('div', 'blyst-row');
    var labMail = el('label', 'blyst-label', TEXT.mailLabel);
    labMail.htmlFor = 'blyst-fb-mail';
    labMail.appendChild(el('span', 'blyst-opt', TEXT.mailHint));
    var mail = document.createElement('input');
    mail.className = 'blyst-field';
    mail.id = 'blyst-fb-mail';
    mail.type = 'email';
    mail.name = 'email';
    mail.autocomplete = 'email';
    rowMail.appendChild(labMail);
    rowMail.appendChild(mail);

    // honeypot
    var hp = el('div', 'blyst-hp');
    hp.setAttribute('aria-hidden', 'true');
    var hpIn = document.createElement('input');
    hpIn.type = 'text';
    hpIn.name = 'website';
    hpIn.tabIndex = -1;
    hpIn.autocomplete = 'off';
    hp.appendChild(hpIn);

    var status = el('p', 'blyst-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.display = 'none';

    var cancel = button('blyst-btn-ghost', 'Cancel');
    var send = button('blyst-btn-primary', 'Send', 'submit');
    var actions = el('div', 'blyst-modal-actions');
    actions.appendChild(cancel);
    actions.appendChild(send);

    form.appendChild(rowMsg);
    form.appendChild(rowMail);
    form.appendChild(hp);
    form.appendChild(el('p', 'blyst-note', TEXT.privacy));
    form.appendChild(status);
    form.appendChild(actions);

    return { form: form, msg: msg, mail: mail, hpIn: hpIn, status: status, cancel: cancel, send: send };
  }

  function openFeedback(trigger) {
    var previouslyFocused = trigger || document.activeElement;

    var scrim = el('div', 'blyst blyst-scrim');
    var modal = el('div', 'blyst-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'blyst-fb-title');

    var title = el('h2', null, TEXT.modalTitle);
    title.id = 'blyst-fb-title';
    var f = buildForm();

    modal.appendChild(title);
    modal.appendChild(el('p', 'blyst-lede', TEXT.modalLede));
    modal.appendChild(f.form);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    f.msg.focus();

    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    }

    // focus trap
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      var items = modal.querySelectorAll('textarea,input:not([tabindex="-1"]),button');
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function fail(text) {
      f.status.className = 'blyst-status blyst-status-err';
      f.status.textContent = text;
      f.status.style.display = '';
      f.send.disabled = false;
      f.send.textContent = 'Send';
    }

    function showThanks() {
      modal.innerHTML = '';
      var done = el('div', 'blyst-done');
      var h = el('h2', null, TEXT.thanksTitle);
      h.id = 'blyst-fb-title';
      var ok = button('blyst-btn-primary', 'Close');
      ok.addEventListener('click', close);
      done.appendChild(h);
      done.appendChild(el('p', null, TEXT.thanksBody));
      done.appendChild(ok);
      modal.appendChild(done);
      ok.focus();
    }

    function submit(e) {
      e.preventDefault();
      f.status.style.display = 'none';

      if (f.hpIn.value) { close(); return; }   // bot, pretend it worked

      var body = f.msg.value.trim();
      var email = f.mail.value.trim();
      if (!body) { fail(TEXT.errEmpty); f.msg.focus(); return; }
      if (email && !isEmail(email)) { fail(TEXT.errEmail); f.mail.focus(); return; }
      if (Date.now() - lastSentAt() < THROTTLE_MS) { fail(TEXT.errThrottle); return; }

      f.send.disabled = true;
      f.send.textContent = 'Sending…';

      var payload = { message: body, page: location.href };
      if (email) payload.email = email;

      fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        markSent();
        showThanks();
      }).catch(function () {
        fail(TEXT.errSend);   // keep their text on failure
      });
    }

    document.addEventListener('keydown', onKey, true);
    f.cancel.addEventListener('click', close);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
    f.form.addEventListener('submit', submit);
  }

  /* start */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
