import type { AppKey, AppSummaryItem, Overview } from "@threatready/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMe } from "../components/AppShell";
import { APP_LABEL, fmtScore } from "../components/Overview";
import { FEATURES, featureUrl } from "../content/features";
import { api } from "../lib/api";
import { useSession } from "../lib/auth-client";
import { fmtAgo } from "../lib/format";

type Item = AppSummaryItem & { app: AppKey };
const FINISHED = /^(report ready|completed|archived|failed|expired|cancelled)/i;

/**
 * "Continue where you left off": unfinished work from every app first, then
 * the most recent. Built from the same overview the profile page shows.
 */
function ContinueStrip() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.overview().then(
      (o: Overview) => {
        if (cancelled) return;
        const open = o.recent.filter((i) => !FINISHED.test(i.status));
        const rest = o.recent.filter((i) => FINISHED.test(i.status));
        setItems([...open, ...rest].slice(0, 3));
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null; // the product cards below still work; the profile page explains failures
  return (
    <section className="continue" aria-labelledby="continue-title">
      <div className="continue-head">
        <h2 id="continue-title" className="profile-section-title">
          Continue where you left off
        </h2>
        <Link className="link-arrow" to="/app/profile">
          All your progress <span aria-hidden="true">→</span>
        </Link>
      </div>
      {items === null ? (
        <ul className="continue-list" aria-hidden="true">
          {[0, 1, 2].map((n) => (
            <li key={n} className="continue-item">
              <span className="tr-skel" style={{ height: 12, width: "35%" }} />
              <span className="tr-skel" style={{ height: 18, width: "80%" }} />
              <span className="tr-skel" style={{ height: 12, width: "50%" }} />
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <p className="continue-empty">
          Nothing started yet. Pick a product below; your sessions, runs and scores will appear here.
        </p>
      ) : (
        <ul className="continue-list">
          {items.map((i) => {
            const open = !FINISHED.test(i.status);
            return (
              <li key={`${i.app}:${i.id}`} className="continue-item">
                <span className={`app-tag app-tag-${i.app}`}>{APP_LABEL[i.app]}</span>
                <a className="continue-title" href={i.url}>
                  {i.title}
                </a>
                <span className="continue-meta">
                  {i.status}
                  {i.score !== null ? ` · Score ${fmtScore(i.score)}` : ""} · {fmtAgo(i.at)}
                </span>
                <span className="continue-cta" aria-hidden="true">
                  {open ? "Resume →" : "View →"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ProductPage() {
  const { me, apps } = useMe();
  const { data: session } = useSession();
  const isTrial = me.user.isTrial;
  const first = session?.user.name?.trim().split(/\s+/)[0] || me.user.username;

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <span className="tr-eyebrow">Your ThreatReady workspace</span>
        <h1 id="hero-title">{isTrial ? "Welcome to ThreatReady" : first ? `Welcome back, ${first}` : "Welcome back"}</h1>
        <p>
          Three ways to build security skills you can explain under pressure: a mock interview built from a real job,
          hands-on incident labs, and attack reasoning scored against a published rubric.
        </p>
      </section>

      {isTrial ? null : <ContinueStrip />}

      {isTrial ? (
        <div className="trial-banner">
          <p>You're on a free trial. Create an account to keep your progress and unlock more sessions.</p>
          <Link className="btn btn-primary" to="/?mode=signup">
            Create account
          </Link>
        </div>
      ) : null}

      <h2 className="profile-section-title products-title">Products</h2>
      <ul className="features" aria-label="ThreatReady products">
        {FEATURES.map((f) => {
          return (
            <li key={f.key} className="feature">
              <div className="feature-art">{f.art}</div>
              <div className="feature-body">
                <h2 id={`feature-${f.key}`}>
                  <span className={`tr-dot tr-dot-${f.app}`} aria-hidden="true" />
                  {f.title}
                </h2>
                <p>{f.description}</p>
                <div className="feature-foot">
                  {(() => {
                    const url = featureUrl(f, apps);
                    if (!url) {
                      return (
                        <>
                          <span className="tr-tag tr-tag-soon">Coming soon</span>
                          <button type="button" className="btn btn-secondary btn-block" disabled>
                            {f.action}
                          </button>
                        </>
                      );
                    }
                    // The apps need an account; a trial session stays on this page.
                    if (isTrial) {
                      return (
                        <>
                          <span className="tr-tag">Needs a free account</span>
                          <Link className="btn btn-secondary btn-block" to="/?mode=signup">
                            Create account to continue
                          </Link>
                        </>
                      );
                    }
                    return (
                      <>
                        <span className="tr-tag tr-tag-live">Live</span>
                        <a className="btn btn-primary btn-block" href={url} aria-describedby={`feature-${f.key}`}>
                          {f.action}
                        </a>
                      </>
                    );
                  })()}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
