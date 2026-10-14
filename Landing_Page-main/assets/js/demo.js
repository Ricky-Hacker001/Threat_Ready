/* ThreatReady — live one-question demo.
   Contract (unchanged): POST https://threatready-db.onrender.com/api/demo/evaluate
     body  { question: string, answer: string }
     reply { score, ti, cr, ab, cq, fa, feedback?, model?, level?, error? }
   Security:
     - No model answers ship to the browser; result.model is shown only after a scored response.
     - All API text is rendered with textContent (never innerHTML).
     - A failed request shows an error state; no score is ever simulated. */
(function () {
  'use strict';
  var API = 'https://threatready-db.onrender.com/api/demo/evaluate';
  var MIN_CHARS = 20, MAX_CHARS = 5000;
  var LIMIT = { max: 5, windowMs: 5 * 60 * 1000, key: 'tr_rl_demoSubmit' };
  var DIMS = [['ti', 'Threat Identification'], ['cr', 'Containment & Response'], ['ab', 'Architecture & Blast Radius'], ['cq', 'Communication Quality'], ['fa', 'Framework Application']];
  var BANDS = [[9, 'Expert'], [7.5, 'Advanced'], [6, 'Proficient'], [4, 'Foundation'], [0, 'Developing']];

  var pool = window.TR_DEMO_SCENARIOS || [];
  var $ = function (id) { return document.getElementById(id); };
  var form = $('demoForm');
  if (!form || !pool.length) return;

  var els = {
    role: $('dRole'), mitre: $('dMitre'), id: $('dId'), diagram: $('dDiagram'), ctx: $('dCtx'), q: $('dScenQuestion'),
    ans: $('dAns'), count: $('dCount'), err: $('dErr'), submit: $('dSubmit'), compose: $('dCompose'),
    loading: $('dLoading'), failed: $('dFailed'), failMsg: $('dFailMsg'), retry: $('dRetry'),
    result: $('dResult'), score: $('dScore'), band: $('dBand'), dims: $('dDims'), feedback: $('dFeedback'), model: $('dModel'),
    again: $('dAgain'), reveal: $('dReveal'), answerArea: $('dAnswerArea')
  };
  var scenario = null;

  function pick() {
    var last = -1;
    try { last = parseInt(sessionStorage.getItem('tr-lastScenario') || '-1', 10); } catch (e) {}
    var i = Math.floor(Math.random() * pool.length);
    if (i === last && pool.length > 1) i = (i + 1) % pool.length;
    try { sessionStorage.setItem('tr-lastScenario', String(i)); } catch (e) {}
    return pool[i];
  }

  function render() {
    scenario = pick();
    els.role.textContent = scenario.role + ' · ' + scenario.level;
    els.mitre.textContent = scenario.mitre;
    els.id.textContent = scenario.id;
    els.ctx.textContent = scenario.context;
    els.q.textContent = scenario.question;
    // Diagram SVG is static first-party markup from demo-scenarios.js (no user or API data).
    els.diagram.innerHTML = scenario.diagram;
    var svg = els.diagram.querySelector('svg');
    if (svg) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Architecture diagram for the ' + scenario.role + ' scenario'); svg.removeAttribute('style'); }
  }

  function show(state) {
    els.compose.hidden = state !== 'compose';
    els.loading.hidden = state !== 'loading';
    els.failed.hidden = state !== 'failed';
    els.result.hidden = state !== 'result';
  }

  function rateLimited() {
    var now = Date.now(), ts = [];
    try { ts = JSON.parse(sessionStorage.getItem(LIMIT.key) || '[]').filter(function (t) { return typeof t === 'number' && now - t < LIMIT.windowMs; }); } catch (e) {}
    if (ts.length >= LIMIT.max) return Math.ceil((LIMIT.windowMs - (now - Math.min.apply(null, ts))) / 1000);
    ts.push(now);
    try { sessionStorage.setItem(LIMIT.key, JSON.stringify(ts)); } catch (e) {}
    return 0;
  }

  function num(v) { var n = Number(v); return isFinite(n) ? Math.max(0, Math.min(10, n)) : null; }
  function band(s) { for (var i = 0; i < BANDS.length; i++) if (s >= BANDS[i][0]) return BANDS[i][1]; return ''; }

  function setErr(msg) { els.err.textContent = msg; els.err.hidden = !msg; }

  function stopVoice() {
    var vb = $('dVoiceBtn');
    if (vb && vb.classList.contains('recording')) vb.click();
  }

  function renderResult(r) {
    var overall = num(r.score);
    els.score.textContent = overall == null ? '—' : String(overall);
    els.band.textContent = overall == null ? '' : band(overall);
    els.band.hidden = overall == null;
    els.dims.textContent = '';
    DIMS.forEach(function (d) {
      var v = num(r[d[0]]);
      var row = document.createElement('div'); row.className = 'dim';
      var l = document.createElement('span'); l.className = 'dim-l'; l.textContent = d[1];
      var bar = document.createElement('span'); bar.className = 'dim-bar'; bar.setAttribute('aria-hidden', 'true');
      var fill = document.createElement('i'); bar.appendChild(fill);
      var val = document.createElement('span'); val.className = 'dim-v'; val.textContent = v == null ? '—' : String(v);
      row.appendChild(l); row.appendChild(bar); row.appendChild(val);
      els.dims.appendChild(row);
      if (v != null) requestAnimationFrame(function () { requestAnimationFrame(function () { fill.style.width = (v * 10) + '%'; }); });
    });
    var fb = typeof r.feedback === 'string' ? r.feedback.trim() : '';
    els.feedback.hidden = !fb;
    els.feedback.querySelector('span').textContent = fb;
    var model = typeof r.model === 'string' ? r.model.trim() : '';
    els.model.hidden = !model;
    els.model.querySelector('span').textContent = model;
  }

  els.reveal.addEventListener('click', function () {
    els.answerArea.hidden = false;
    els.reveal.hidden = true;
    els.ans.focus();
  });

  els.ans.addEventListener('input', function () {
    els.count.textContent = els.ans.value.length + ' / ' + MAX_CHARS;
    if (els.ans.value.trim().length >= MIN_CHARS) setErr('');
  });
  ['copy', 'cut', 'paste'].forEach(function (ev) {
    els.ans.addEventListener(ev, function (e) { e.preventDefault(); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var answer = els.ans.value.trim();
    if (answer.length < MIN_CHARS) { setErr('Write at least a sentence or two — the scorer needs something to evaluate.'); els.ans.focus(); return; }
    var wait = rateLimited();
    if (wait) { setErr('Too many attempts. Try again in ' + wait + ' seconds.'); return; }
    setErr('');
    stopVoice();
    show('loading');
    els.submit.disabled = true;

    var controller = 'AbortController' in window ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 60000) : null;

    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: scenario.question, answer: answer.slice(0, MAX_CHARS) }),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (r) {
      if (!r || r.error) throw new Error('evaluation error');
      if (num(r.score) == null && DIMS.every(function (d) { return num(r[d[0]]) == null; })) throw new Error('no score in response');
      renderResult(r);
      show('result');
      els.result.focus();
    }).catch(function (err) {
      els.failMsg.textContent = err && err.name === 'AbortError'
        ? 'The scoring service took too long to respond. It may be starting up — please try again in a minute.'
        : 'The scoring service is unavailable right now, so no score was produced. Your answer is still in the box.';
      show('failed');
    }).then(function () {
      if (timer) clearTimeout(timer);
      els.submit.disabled = false;
    });
  });

  els.retry.addEventListener('click', function () { show('compose'); els.ans.focus(); });
  els.again.addEventListener('click', function () {
    els.ans.value = '';
    els.count.textContent = '0 / ' + MAX_CHARS;
    render();
    show('compose');
    els.answerArea.hidden = true;
    els.reveal.hidden = false;
    els.reveal.focus();
  });

  render();
  show('compose');
})();
