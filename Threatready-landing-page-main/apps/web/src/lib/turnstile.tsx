import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "../components/ui";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id: string) => void;
      remove: (id: string) => void;
    };
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** A blocked or stalled script must not leave the form silently disabled: give up waiting after this long. */
const LOAD_TIMEOUT_MS = 5000;
let loader: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loader ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loader = null;
      s.remove();
      reject(new Error("turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return loader;
}

/**
 * Cloudflare Turnstile, explicit render. Tokens are single-use, so callers
 * reset() after every submission. With no site key (local dev) it renders
 * nothing and `ready` is always true; the API skips the check too.
 *
 * `element` carries its own status: "Verifying you're human…" while the check
 * runs, and a plain-language error with a retry when it can't load (blocked
 * script, content blocker, network), so a gated button is never disabled
 * without a reason.
 */
export function useTurnstile(siteKey: string | null | undefined, action: string) {
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled && !widget.current) setFailed(true);
    }, LOAD_TIMEOUT_MS);
    loadScript()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        widget.current = window.turnstile.render(box.current, {
          sitekey: siteKey,
          action,
          appearance: "interaction-only",
          callback: (t: string) => {
            setToken(t);
            setFailed(false);
          },
          "expired-callback": () => setToken(null),
          "error-callback": () => setFailed(true),
        });
        // A late load (after the timeout) still recovers on its own.
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, action, attempt]);

  const reset = useCallback(() => {
    setToken(null);
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, []);

  const retry = useCallback(() => {
    setToken(null);
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  const element = siteKey ? (
    <div className="turnstile-wrap">
      <div ref={box} className="turnstile" />
      {failed ? (
        <Notice tone="error">
          We couldn't load the check that confirms you're human. Check your connection, or allow
          challenges.cloudflare.com if a content blocker is on, then try again.{" "}
          <button type="button" className="link-btn" onClick={retry}>
            Try again
          </button>
        </Notice>
      ) : !token ? (
        <p className="field-hint" role="status">
          <span className="spinner spinner-sm" aria-hidden="true" /> Verifying you're human…
        </p>
      ) : null}
    </div>
  ) : null;
  const headers: Record<string, string> = token ? { "x-captcha-response": token } : {};

  return { element, token, headers, reset, retry, ready: !siteKey || !!token, failed };
}
