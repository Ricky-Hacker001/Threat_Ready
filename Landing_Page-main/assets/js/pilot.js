/* ThreatReady — pilot request form.
   Delivery:
     - If FORMSPREE_ID is set, submits to Formspree (AJAX) and shows inline success/error.
     - Otherwise (current state), opens a pre-filled email to humanresource@aerovanttech.com.
       The previous build posted to the placeholder "YOUR_PILOT_FORM_ID", so every request failed.
   To switch on Formspree: set FORMSPREE_ID below and add https://formspree.io to the page CSP
   (connect-src and form-action). */
(function () {
  'use strict';
  var FORMSPREE_ID = '';            // e.g. 'xayzabcd'
  var TO = 'humanresource@aerovanttech.com';

  var form = document.getElementById('pilotForm');
  if (!form) return;
  var btn = document.getElementById('pilotBtn');
  var ok = document.getElementById('pilotSuccess');
  var okMsg = document.getElementById('pilotSuccessMsg');
  var err = document.getElementById('pilotError');
  var fieldsWrap = document.getElementById('pilotFields');

  // ?type=academic preselects the organisation type
  try {
    if (new URLSearchParams(location.search).get('type') === 'academic') {
      var t = form.querySelector('#f-type'); if (t) t.value = 'College or bootcamp';
    }
  } catch (e) {}

  function summary(fd) {
    var roles = fd.getAll('roles');
    var lines = [
      'Name: ' + (fd.get('name') || ''),
      'Work email: ' + (fd.get('email') || ''),
      'Organisation: ' + (fd.get('company') || ''),
      'Organisation type: ' + (fd.get('org_type') || ''),
      'Role: ' + (fd.get('role') || ''),
      'Team / cohort size: ' + (fd.get('team_size') || ''),
      'Hires or learners per year: ' + (fd.get('hires_per_year') || ''),
      'Role tracks: ' + (roles.length ? roles.join(', ') : '—'),
      '',
      'About our process:',
      (fd.get('message') || '—')
    ];
    return lines.join('\n');
  }

  function showError(msg) { err.textContent = msg; err.hidden = false; err.focus(); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.hidden = true;
    if (form.querySelector('input[name="_gotcha"]').value) return;          // honeypot
    if (!form.checkValidity()) {
      var bad = form.querySelector(':invalid');
      showError('Please complete the required fields' + (bad && bad.labels && bad.labels[0] ? ': ' + bad.labels[0].textContent.replace('*', '').trim() : '') + '.');
      if (bad) bad.focus();
      return;
    }
    var fd = new FormData(form);
    var subject = 'ThreatReady pilot request — ' + (fd.get('company') || '');

    if (!FORMSPREE_ID) {
      var href = 'mailto:' + TO + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(summary(fd));
      window.location.href = href;
      fieldsWrap.hidden = true;
      okMsg.textContent = 'Your email app should now be open with the request filled in — press send. If nothing opened, email ' + TO + ' with the details below.';
      document.getElementById('pilotCopy').textContent = summary(fd);
      document.getElementById('pilotCopyWrap').hidden = false;
      ok.hidden = false; ok.focus();
      return;
    }

    btn.disabled = true; var label = btn.textContent; btn.textContent = 'Sending…';
    var body = new FormData(form);
    var roles = body.getAll('roles'); body.delete('roles'); body.set('roles', roles.join(', '));
    body.set('_subject', subject);
    fetch('https://formspree.io/f/' + encodeURIComponent(FORMSPREE_ID), { method: 'POST', headers: { Accept: 'application/json' }, body: body })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
      .then(function () {
        fieldsWrap.hidden = true;
        okMsg.textContent = 'Thanks — we will reply from ' + TO + ' within one business day. Check your spam folder if you do not see it.';
        ok.hidden = false; ok.focus();
      })
      .catch(function () { showError('Sending failed. Please try again, or email ' + TO + ' directly.'); })
      .then(function () { btn.disabled = false; btn.textContent = label; });
  });
})();
