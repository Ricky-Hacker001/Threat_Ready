/**
 * Process-level last resort. An uncaught exception or unhandled rejection leaves the process in an
 * unknown state (half-written transaction, dangling pool client, timer that will never fire). The
 * handlers log it, flush Sentry when it is initialised, and exit non-zero so the launcher starts a
 * clean process. They never swallow the error and never keep serving from a corrupted process.
 */
export interface CrashDeps {
  log: { fatal: (obj: object, msg: string) => void };
  /** Flushes pending Sentry events; resolves quickly when Sentry is not initialised. */
  flush: () => Promise<unknown>;
  exit: (code: number) => void;
  /** Upper bound on how long the flush may hold the exit. */
  flushTimeoutMs?: number;
  /** Event emitter to attach to; the real process by default. */
  target?: { on(event: string, listener: (...args: unknown[]) => void): unknown };
}

export type CrashKind = 'uncaughtException' | 'unhandledRejection';

export function describeCrash(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { value: String(err) };
}

export function installCrashHandlers(deps: CrashDeps): (kind: CrashKind, err: unknown) => void {
  const target = deps.target ?? (process as { on(event: string, listener: (...args: unknown[]) => void): unknown });
  let exiting = false;
  const die = (kind: CrashKind, err: unknown): void => {
    // The first fatal error wins; a second one during shutdown must not restart the sequence.
    if (exiting) return;
    exiting = true;
    try {
      deps.log.fatal({ kind, err: describeCrash(err) }, 'fatal: process exiting for a clean restart');
    } catch {
      // Logging must never prevent the exit.
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      deps.exit(1);
    };
    const timer = setTimeout(finish, deps.flushTimeoutMs ?? 3_000);
    Promise.resolve()
      .then(() => deps.flush())
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        finish();
      });
  };
  target.on('uncaughtException', (err) => die('uncaughtException', err));
  target.on('unhandledRejection', (reason) => die('unhandledRejection', reason));
  return die;
}
