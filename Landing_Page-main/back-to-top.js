/* ThreatReady — back-to-top floating button
 * Self-contained: injects the button into <body>, watches scroll
 * position, fades/slides it in once the user scrolls past 300px,
 * and smooth-scrolls to top on click.
 *
 * Used by every additional-doc page (privacy, terms, security,
 * dpa, rubric, pilot, sample-report). Index.html does NOT load
 * this — the landing page already has its own nav-based jumps.
 */
(function(){
  'use strict';

  // Don't double-inject if the script ever runs twice
  if (document.querySelector('.b2t')) return;

  function init(){
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'b2t';
    btn.setAttribute('aria-label', 'Back to top');
    btn.setAttribute('title', 'Back to top');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M12 19V5M5 12l7-7 7 7" ' +
      'stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    document.body.appendChild(btn);

    // Threshold: 300px feels right — far enough that the button
    // doesn't appear on the hero fold, close enough that it shows
    // up the moment a user starts reading content.
    var THRESHOLD = 300;
    var visible = false;
    var ticking = false;

    function update(){
      ticking = false;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      var shouldShow = y > THRESHOLD;
      if (shouldShow !== visible){
        visible = shouldShow;
        btn.classList.toggle('visible', visible);
      }
    }

    // rAF throttling — scroll events fire 60+/sec, we only need
    // to update once per frame.
    function onScroll(){
      if (!ticking){
        window.requestAnimationFrame(update);
        ticking = true;
      }
    }

    btn.addEventListener('click', function(){
      // Respect users who prefer reduced motion
      var reduced = window.matchMedia &&
                    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      try {
        window.scrollTo({
          top: 0,
          behavior: reduced ? 'auto' : 'smooth'
        });
      } catch(e){
        // Older browsers — fallback to instant
        window.scrollTo(0, 0);
      }
    });

    window.addEventListener('scroll', onScroll, { passive: true });

    // Run once on load — handles back-button-restored scroll positions
    update();
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
