import {
  OTP_LENGTH,
  OTP_TTL_SECONDS,
  PASSWORD_MIN,
  PLAN_LIMITS,
  emailSchema,
  otpSchema,
  passwordSchema,
  usernameSchema,
} from "@threatready/contracts";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import type { ZodType } from "zod";
import { CaseFile } from "../components/CaseFile";
import { ThemeToggle } from "../components/Platform";
import { Brand, Button, Field, GitHubLogo, GoogleLogo, Notice, PasswordField } from "../components/ui";
import { api, ApiError, type PublicConfig } from "../lib/api";
import { authClient, useSession } from "../lib/auth-client";
import { messageFor, OAUTH_MESSAGES } from "../lib/errors";
import { pendingNext } from "../lib/platform";
import { useTurnstile } from "../lib/turnstile";

type Flash = { tone: "ok" | "info" | "error"; text: string } | null;

type View =
  | { name: "signin"; username?: string; flash?: Flash }
  | { name: "signup" }
  | { name: "verify"; email?: string; username?: string; fromSignIn?: boolean }
  | { name: "forgot-username" }
  | { name: "forgot-password" };

type AuthError = { code?: string; status?: number; message?: string } | null | undefined;

function check<T>(schema: ZodType<T>, value: unknown): string | null {
  const r = schema.safeParse(value);
  return r.success ? null : (r.error.issues[0]?.message ?? "Invalid value");
}

const otpMinutes = Math.round(OTP_TTL_SECONDS / 60);
const trial = PLAN_LIMITS.trial;

/* ------------------------------------------------------------------ */

export function AuthPage() {
  const { data: session, isPending } = useSession();
  const [params, setParams] = useSearchParams();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [view, setView] = useState<View>(() => {
    if (params.get("mode") === "signup") return { name: "signup" };
    const oauthError = params.get("error");
    return {
      name: "signin",
      username: params.get("username") ?? undefined,
      flash: oauthError
        ? { tone: "error", text: OAUTH_MESSAGES[oauthError] ?? "Sign-in with that provider didn't complete. Try again." }
        : null,
    };
  });
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    api
      .config()
      .then(setConfig, () =>
        setConfig({ providers: { google: false, github: false }, turnstileSiteKey: null, apps: [], appOrigins: [] }),
      );
  }, []);

  // Drop one-shot query params once read so a refresh doesn't replay them.
  useEffect(() => {
    if (params.has("error") || params.has("username") || params.has("mode")) setParams({}, { replace: true });
  }, [params, setParams]);

  // Move focus to the new heading when the view changes (screen readers,
  // keyboard users). Not on first load: the first field gets focus instead.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [view.name]);

  const user = session?.user as { isAnonymous?: boolean | null } | undefined;
  if (!isPending && session && !user?.isAnonymous) return <Navigate to="/app" replace />;
  const inTrial = !!session && !!user?.isAnonymous;

  const siteKey = config?.turnstileSiteKey ?? null;
  const go = (v: View) => setView(v);

  let heading: string;
  let lead: ReactNode;
  let body: ReactNode;
  switch (view.name) {
    case "signin":
      heading = "Sign in to ThreatReady";
      lead = "Pick up your interview prep, simulations and reasoning practice.";
      body = <SignIn view={view} siteKey={siteKey} go={go} />;
      break;
    case "signup":
      heading = "Create your account";
      lead = "We'll email you a code to confirm your address.";
      body = <SignUp siteKey={siteKey} go={go} />;
      break;
    case "verify":
      heading = "Verify your email";
      lead = null;
      body = <Verify view={view} siteKey={siteKey} go={go} />;
      break;
    case "forgot-username":
      heading = "Find your username";
      lead = "Enter the email on your account. We'll send your username there.";
      body = <ForgotUsername siteKey={siteKey} go={go} />;
      break;
    case "forgot-password":
      heading = "Reset your password";
      lead = null;
      body = <ForgotPassword siteKey={siteKey} go={go} />;
      break;
  }

  const showTabs = view.name === "signin" || view.name === "signup";
  // Sent here by another ThreatReady app: say where they'll land after signing in.
  const returningTo = (() => {
    const next = pendingNext();
    if (!next || !config) return null;
    try {
      const origin = new URL(next).origin;
      return config.apps.find((a) => a.url === origin)?.title ?? null;
    } catch {
      return null;
    }
  })();

  return (
    <div className="auth">
      <a className="skip-link" href="#auth-form">
        Skip to sign-in form
      </a>
      <main className="auth-main">
        <div className="auth-top">
          <Brand />
          <ThemeToggle />
        </div>
        <div className="auth-form-wrap" id="auth-form">
          {inTrial ? (
            <Notice tone="info">
              You're in a free trial. Create an account to keep going, or{" "}
              <Link to="/app">go back to your trial</Link>.
            </Notice>
          ) : null}

          {returningTo && !inTrial ? (
            <Notice tone="info">Sign in to continue to {returningTo}.</Notice>
          ) : null}

          {showTabs ? (
            <div className="tabs" role="tablist" aria-label="Account">
              <button
                type="button"
                role="tab"
                className="tab"
                aria-selected={view.name === "signin"}
                onClick={() => go({ name: "signin" })}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                className="tab"
                aria-selected={view.name === "signup"}
                onClick={() => go({ name: "signup" })}
              >
                Create account
              </button>
            </div>
          ) : (
            <div className="back-row">
              <Button type="button" variant="quiet" onClick={() => go({ name: "signin" })}>
                <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Back to sign in
              </Button>
            </div>
          )}

          <div className="auth-heading">
            <h1 ref={headingRef} tabIndex={-1}>
              {heading}
            </h1>
            {lead ? <p>{lead}</p> : null}
          </div>

          {body}

          {showTabs ? (
            <>
              <div className="divider">or</div>
              <SocialButtons providers={config?.providers} />
              {inTrial ? null : <TrialBlock siteKey={siteKey} />}
            </>
          ) : null}
        </div>
      </main>
      <CaseFile />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SignIn({ view, siteKey, go }: { view: Extract<View, { name: "signin" }>; siteKey: string | null; go: (v: View) => void }) {
  const navigate = useNavigate();
  const ts = useTurnstile(siteKey, "sign-in");
  const [username, setUsername] = useState(view.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.username({
      username: username.trim(),
      password,
      fetchOptions: { headers: ts.headers },
    });
    ts.reset();
    setBusy(false);
    if (!err) {
      navigate("/app", { replace: true });
      return;
    }
    if (err.code === "EMAIL_NOT_VERIFIED") {
      go({ name: "verify", username: username.trim(), fromSignIn: true });
      return;
    }
    setError(messageFor(err as AuthError));
    setPassword("");
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {view.flash ? <Notice tone={view.flash.tone}>{view.flash.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field
        label="Username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        error={touched && !username.trim() ? "Enter your username" : null}
        required
      />
      <PasswordField
        label="Password"
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={touched && !password ? "Enter your password" : null}
        required
      />
      <div className="form-row-links">
        <button type="button" className="link-btn" onClick={() => go({ name: "forgot-username" })}>
          Forgot username?
        </button>
        <button type="button" className="link-btn" onClick={() => go({ name: "forgot-password" })}>
          Forgot password?
        </button>
      </div>
      {ts.element}
      <Button type="submit" block loading={busy} disabled={!ts.ready}>
        Sign in
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function SignUp({ siteKey, go }: { siteKey: string | null; go: (v: View) => void }) {
  const ts = useTurnstile(siteKey, "sign-up");
  const [form, setForm] = useState({ username: "", email: "", password: "" });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = {
    username: check(usernameSchema, form.username),
    email: check(emailSchema, form.email),
    password: check(passwordSchema, form.password),
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (errors.username || errors.email || errors.password) return;
    setBusy(true);
    setError(null);
    const username = form.username.trim();
    const email = form.email.trim().toLowerCase();
    const { error: err } = await authClient.signUp.email({
      username,
      name: username,
      email,
      password: form.password,
      fetchOptions: { headers: ts.headers },
    });
    ts.reset();
    setBusy(false);
    if (err) {
      setError(messageFor(err as AuthError));
      return;
    }
    go({ name: "verify", email, username });
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field
        label="Username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={form.username}
        onChange={set("username")}
        hint="3–30 characters: letters, numbers, dots and underscores."
        error={touched ? errors.username : null}
        required
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={form.email}
        onChange={set("email")}
        error={touched ? errors.email : null}
        required
      />
      <PasswordField
        label="Password"
        name="new-password"
        autoComplete="new-password"
        value={form.password}
        onChange={set("password")}
        hint={`At least ${PASSWORD_MIN} characters. A short phrase works well.`}
        error={touched ? errors.password : null}
        required
      />
      {ts.element}
      <Button type="submit" block loading={busy} disabled={!ts.ready}>
        Create account
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function useCooldown(seconds: number) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return { left, start: () => setLeft(seconds) };
}

function Verify({ view, siteKey, go }: { view: Extract<View, { name: "verify" }>; siteKey: string | null; go: (v: View) => void }) {
  const ts = useTurnstile(siteKey, "resend-otp");
  const [email, setEmail] = useState(view.email ?? "");
  const [otp, setOtp] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const cooldown = useCooldown(60);
  const knownEmail = !!view.email;

  const errors = { email: check(emailSchema, email), otp: check(otpSchema, otp) };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (errors.email || errors.otp) return;
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.emailOtp.verifyEmail({ email: email.trim().toLowerCase(), otp: otp.trim() });
    setBusy(false);
    if (err) {
      setError(messageFor(err as AuthError));
      if (err.code === "OTP_EXPIRED" || err.code === "TOO_MANY_ATTEMPTS") setOtp("");
      return;
    }
    go({
      name: "signin",
      username: view.username,
      flash: { tone: "ok", text: "Email verified. Sign in with your username and password." },
    });
  }

  async function resend() {
    setTouched(true);
    if (errors.email) return;
    setResending(true);
    setError(null);
    setFlash(null);
    const { error: err } = await authClient.emailOtp.sendVerificationOtp({
      email: email.trim().toLowerCase(),
      type: "email-verification",
      fetchOptions: { headers: ts.headers },
    });
    ts.reset();
    setResending(false);
    if (err) {
      setError(messageFor(err as AuthError));
      return;
    }
    cooldown.start();
    setFlash("If that email belongs to an unverified account, a new code is on its way.");
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {knownEmail ? (
        <p>
          Enter the {OTP_LENGTH}-digit code we sent to <strong>{view.email}</strong>. It expires in {otpMinutes} minutes.
          If that email already has an account, we've emailed you instead.
        </p>
      ) : (
        <p>
          {view.fromSignIn ? "Your email isn't verified yet. We've sent a new code. " : ""}
          Enter the email on your account and the {OTP_LENGTH}-digit code.
        </p>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {flash ? <Notice tone="info">{flash}</Notice> : null}
      {knownEmail ? null : (
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={touched ? errors.email : null}
        />
      )}
      <Field
        label="Verification code"
        otp
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={OTP_LENGTH}
        value={otp}
        onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH))}
        error={touched ? errors.otp : null}
      />
      {ts.element}
      <Button type="submit" block loading={busy}>
        Verify email
      </Button>
      <p className="field-hint">
        Didn't get it? Check spam, or{" "}
        <button type="button" className="link-btn" onClick={resend} disabled={resending || cooldown.left > 0 || !ts.ready}>
          {cooldown.left > 0 ? `send a new code in ${cooldown.left}s` : "send a new code"}
        </button>
        .
      </p>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function ForgotUsername({ siteKey, go }: { siteKey: string | null; go: (v: View) => void }) {
  const ts = useTurnstile(siteKey, "forgot-username");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailError = check(emailSchema, email);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (emailError) return;
    setBusy(true);
    setError(null);
    try {
      const clean = email.trim().toLowerCase();
      await api.forgotUsername(clean, ts.token ?? undefined);
      setSentTo(clean);
    } catch (err) {
      setError(err instanceof ApiError ? messageFor(err) : messageFor(null));
    } finally {
      ts.reset();
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="form">
        <Notice tone="ok">
          If <strong>{sentTo}</strong> has a ThreatReady account, its username is on the way. Check your inbox.
        </Notice>
        <Button type="button" block onClick={() => go({ name: "signin" })}>
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={touched ? emailError : null}
      />
      {ts.element}
      <Button type="submit" block loading={busy} disabled={!ts.ready}>
        Email my username
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function ForgotPassword({ siteKey, go }: { siteKey: string | null; go: (v: View) => void }) {
  const ts = useTurnstile(siteKey, "forgot-password");
  const [step, setStep] = useState<"email" | "code" | "password">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cooldown = useCooldown(60);

  const cleanEmail = email.trim().toLowerCase();
  const emailError = check(emailSchema, email);
  const otpError = check(otpSchema, otp);
  const pwError = check(passwordSchema, password);
  const confirmError = confirm !== password ? "Passwords don't match" : null;

  async function sendCode() {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.emailOtp.requestPasswordReset({
      email: cleanEmail,
      fetchOptions: { headers: ts.headers },
    });
    ts.reset();
    setBusy(false);
    if (err) {
      setError(messageFor(err as AuthError));
      return false;
    }
    cooldown.start();
    return true;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);

    if (step === "email") {
      if (emailError) return;
      if (await sendCode()) {
        setTouched(false);
        setStep("code");
      }
      return;
    }

    if (step === "code") {
      if (otpError) return;
      setBusy(true);
      const { error: err } = await authClient.emailOtp.checkVerificationOtp({
        email: cleanEmail,
        otp: otp.trim(),
        type: "forget-password",
      });
      setBusy(false);
      if (err) {
        // USER_NOT_FOUND only after a correct code (the inbox already knows); keep it generic anyway.
        setError(err.code === "USER_NOT_FOUND" ? messageFor({ code: "INVALID_OTP" }) : messageFor(err as AuthError));
        if (err.code === "OTP_EXPIRED" || err.code === "TOO_MANY_ATTEMPTS") setOtp("");
        return;
      }
      setTouched(false);
      setStep("password");
      return;
    }

    if (pwError || confirmError) return;
    setBusy(true);
    const { error: err } = await authClient.emailOtp.resetPassword({ email: cleanEmail, otp: otp.trim(), password });
    setBusy(false);
    if (err) {
      if (err.code === "INVALID_OTP" || err.code === "OTP_EXPIRED" || err.code === "TOO_MANY_ATTEMPTS") {
        setOtp("");
        setStep("code");
      }
      setError(messageFor(err as AuthError));
      return;
    }
    go({
      name: "signin",
      flash: { tone: "ok", text: "Password changed and other sessions signed out. Sign in with your new password." },
    });
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {step === "email" ? <p>Enter the email on your account. We'll send a {OTP_LENGTH}-digit code to confirm it's you.</p> : null}
      {step === "code" ? (
        <p>
          If <strong>{cleanEmail}</strong> has an account, a code is on its way. It expires in {otpMinutes} minutes.
        </p>
      ) : null}
      {step === "password" ? <p>Code confirmed. Choose a new password.</p> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {step === "email" ? (
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={touched ? emailError : null}
        />
      ) : null}

      {step === "code" ? (
        <Field
          label="Reset code"
          otp
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={OTP_LENGTH}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH))}
          error={touched ? otpError : null}
        />
      ) : null}

      {step === "password" ? (
        <>
          <input type="text" name="username" autoComplete="username" value={cleanEmail} readOnly hidden />
          <PasswordField
            label="New password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={`At least ${PASSWORD_MIN} characters.`}
            error={touched ? pwError : null}
          />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={touched ? confirmError : null}
          />
        </>
      ) : null}

      {step !== "password" ? ts.element : null}
      <Button type="submit" block loading={busy} disabled={step === "email" && !ts.ready}>
        {step === "email" ? "Send code" : step === "code" ? "Confirm code" : "Change password"}
      </Button>

      {step === "code" ? (
        <p className="field-hint">
          Didn't get it?{" "}
          <button
            type="button"
            className="link-btn"
            disabled={busy || cooldown.left > 0 || !ts.ready}
            onClick={() => void sendCode()}
          >
            {cooldown.left > 0 ? `Send a new code in ${cooldown.left}s` : "Send a new code"}
          </button>
        </p>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------ */

function SocialButtons({ providers }: { providers: PublicConfig["providers"] | undefined }) {
  const [busy, setBusy] = useState<"google" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(provider: "google" | "github") {
    setBusy(provider);
    setError(null);
    const origin = window.location.origin;
    const { error: err } = await authClient.signIn.social({
      provider,
      callbackURL: `${origin}/app`,
      errorCallbackURL: `${origin}/`,
    });
    if (err) {
      setBusy(null);
      setError(messageFor(err as AuthError));
    }
  }

  const unavailable = "Not set up on this server yet";
  return (
    <div className="form">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="social">
        <Button
          type="button"
          variant="secondary"
          loading={busy === "google"}
          disabled={!providers?.google || busy !== null}
          title={providers && !providers.google ? unavailable : undefined}
          onClick={() => void start("google")}
        >
          {busy === "google" ? null : <GoogleLogo />}
          Continue with Google
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={busy === "github"}
          disabled={!providers?.github || busy !== null}
          title={providers && !providers.github ? unavailable : undefined}
          onClick={() => void start("github")}
        >
          {busy === "github" ? null : <GitHubLogo />}
          Continue with GitHub
        </Button>
      </div>
    </div>
  );
}

function TrialBlock({ siteKey }: { siteKey: string | null }) {
  const navigate = useNavigate();
  const ts = useTurnstile(siteKey, "trial");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.anonymous({ fetchOptions: { headers: ts.headers } });
    ts.reset();
    setBusy(false);
    if (err) {
      setError(messageFor(err as AuthError));
      return;
    }
    navigate("/app", { replace: true });
  }

  const plural = (n: number | null, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <section className="trial" aria-labelledby="trial-title">
      <h2 id="trial-title">Try it without an account</h2>
      <p>
        Get {plural(trial.interview.limit, "interview", "interviews")},{" "}
        {plural(trial.simulations.limit, "simulation", "simulations")} and{" "}
        {plural(trial.reasoning.limit, "reasoning session", "reasoning sessions")}. No email needed.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {ts.element}
      <Button type="button" variant="signal" block loading={busy} disabled={!ts.ready} onClick={() => void start()}>
        Start free trial
      </Button>
    </section>
  );
}
