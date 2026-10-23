// Internal badges (#/badges). Progress inside this simulation only: no
// certificate, no print page, no download, no verification id.

import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, stamp } from '../components/bits.jsx';
import { Shield } from '../components/Badge.jsx';
import { Brand, NameChip, Footer } from '../Console.jsx';

export default function BadgesPage({ go }) {
  const [levels, setLevels] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.levels().then(setLevels).catch(setErr); }, []);
  const all = levels && levels.every((l) => l.badge);

  return (
    <main className="page">
      <header className="home-head">
        <div>
          <Brand />
          <p><button type="button" className="link" onClick={() => go('#/')}>SOC home</button></p>
          <h1>Internal badges</h1>
        </div>
        <NameChip />
      </header>
      <ErrorNote error={err} onDismiss={() => setErr(null)} />
      {!levels && !err && <p className="muted">Loading…</p>}
      {all && <p className="note">All three SOC Simulation levels completed.</p>}
      <div className="badge-tiles">
        {(levels || []).map((l) => (
          <article key={l.id} className={`badge-tile${l.badge ? ' is-earned' : ''}`}>
            <Shield level={l.id} earned={!!l.badge} size={72} />
            <h2>{l.name} badge</h2>
            {l.badge ? (
              <dl className="facts">
                <div><dt>Earned</dt><dd>{stamp(l.badge.earnedAt)} UTC</dd></div>
                <div><dt>Average when earned</dt><dd>{l.badge.average}</dd></div>
                <div><dt>Passed when earned</dt><dd>{l.badge.passedCount} of 12</dd></div>
              </dl>
            ) : (
              <>
                <p>Not yet earned. {l.passed} of {l.released || 12} passed (badge at {l.badgeAt}).</p>
                <p><button type="button" className="link" onClick={() => go(`#/level/${l.id}`)}>{l.state === 'locked' ? `View ${l.name} (locked)` : `Open ${l.name}`}</button></p>
              </>
            )}
          </article>
        ))}
      </div>
      <p className="muted">Internal badges show progress inside this simulation. They are not a certification or professional qualification.</p>
      <p><button type="button" className="btn" onClick={() => go('#/report')}>Final analyst report</button></p>
      <Footer />
    </main>
  );
}
