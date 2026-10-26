/**
 * ADD L7: "A route with none fails closed and fails CI."
 * Every controller handler must be @Public() or declare @RequirePermission().
 * Runs against the compiled output: node --test test/routes.test.mjs
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IS_PUBLIC, REQUIRED_PERMISSION, PERMISSIONS } from "../dist/authz/authz.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

async function controllerFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...(await controllerFiles(`${p}/`)));
    else if (entry.name.endsWith(".controller.js")) out.push(p);
  }
  return out;
}

test("every route is public or declares a known permission", async () => {
  const files = await controllerFiles(dist);
  assert.ok(files.length > 0);
  const missing = [];
  let checked = 0;
  for (const file of files) {
    const mod = await import(pathToFileURL(file).href);
    for (const ctrl of Object.values(mod)) {
      if (typeof ctrl !== "function" || !Reflect.hasMetadata("path", ctrl)) continue;
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (name === "constructor" || typeof handler !== "function" || !Reflect.hasMetadata("method", handler)) continue;
        checked++;
        const isPublic = Reflect.getMetadata(IS_PUBLIC, handler) ?? Reflect.getMetadata(IS_PUBLIC, ctrl);
        const perm = Reflect.getMetadata(REQUIRED_PERMISSION, handler) ?? Reflect.getMetadata(REQUIRED_PERMISSION, ctrl);
        if (!isPublic && !PERMISSIONS.includes(perm)) missing.push(`${ctrl.name}.${name}`);
      }
    }
  }
  assert.ok(checked >= 6, `only ${checked} handlers found`);
  assert.deepEqual(missing, [], `routes without a permission: ${missing.join(", ")}`);
});

/* ---------------- Per-caller internal tokens (deploy/README.md "Internal tokens") ---------------- */
import { internalTokenMatches } from "../dist/platform/internal-token.js";
import { loadConfig } from "../dist/config.js";

const RAW = "r".repeat(48);
const LABS = "l".repeat(64);
const AR = "a".repeat(64);
const INTERVIEW = "i".repeat(64);
const baseEnv = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "s".repeat(40),
  BETTER_AUTH_URL: "https://tr.example",
  WEB_ORIGIN: "https://tr.example",
  INTERVIEW_APP_URL: "https://tr.example/interview-prep/",
  LABS_APP_URL: "https://tr.example/labs/",
  REASONING_APP_URL: "https://tr.example/ar/",
  INTERNAL_API_TOKEN: RAW,
  EMAIL_DRIVER: "resend",
  RESEND_API_KEY: "re_x",
  ALLOW_NO_CAPTCHA: "true",
};
const bearer = (t) => `Bearer ${t}`;

test("internal token: each caller's token is accepted, another app's derived token and garbage are not", () => {
  const accept = [LABS, AR, INTERVIEW];
  for (const t of accept) assert.equal(internalTokenMatches(bearer(t), accept), true);
  assert.equal(internalTokenMatches(bearer("o".repeat(64)), accept), false, "a token minted for another callee");
  assert.equal(internalTokenMatches(bearer(LABS.slice(0, 63)), accept), false, "near miss");
  assert.equal(internalTokenMatches(bearer(RAW), accept), false, "raw token not in the list");
  assert.equal(internalTokenMatches(undefined, accept), false);
  assert.equal(internalTokenMatches("Basic abc", accept), false);
  assert.equal(internalTokenMatches(bearer(LABS), LABS), true, "single-token form still works");
});

test("config: production accepts only INTERNAL_TOKENS_ACCEPT (raw token rejected); legacy flag or non-production adds the raw token", () => {
  const prod = loadConfig({ ...baseEnv, NODE_ENV: "production", INTERNAL_TOKENS_ACCEPT: `${LABS}, ${AR},${INTERVIEW}` });
  assert.deepEqual([...prod.internalTokensAccept], [LABS, AR, INTERVIEW]);
  assert.equal(internalTokenMatches(bearer(RAW), prod.internalTokensAccept), false, "production rejects the raw INTERNAL_API_TOKEN");
  assert.equal(internalTokenMatches(bearer(AR), prod.internalTokensAccept), true);

  const legacy = loadConfig({ ...baseEnv, NODE_ENV: "production", INTERNAL_TOKENS_ACCEPT: LABS, INTERNAL_TOKEN_LEGACY_ACCEPT: "true" });
  assert.deepEqual([...legacy.internalTokensAccept], [LABS, RAW]);

  const dev = loadConfig({ ...baseEnv, NODE_ENV: "development", INTERNAL_TOKENS_ACCEPT: LABS });
  assert.deepEqual([...dev.internalTokensAccept], [LABS, RAW], "outside production the raw token is accepted too");
  const devStrict = loadConfig({ ...baseEnv, NODE_ENV: "development", INTERNAL_TOKENS_ACCEPT: LABS, INTERNAL_TOKEN_LEGACY_ACCEPT: "false" });
  assert.deepEqual([...devStrict.internalTokensAccept], [LABS]);

  const none = loadConfig({ ...baseEnv, NODE_ENV: "production" });
  assert.deepEqual([...none.internalTokensAccept], [RAW], "no per-caller list → the raw token (local dev unchanged)");
  const short = loadConfig({ ...baseEnv, NODE_ENV: "production", INTERNAL_TOKENS_ACCEPT: "too-short" });
  assert.deepEqual([...short.internalTokensAccept], [RAW], "tokens under 32 characters are ignored");
});

test("config: onboard presents the token minted for each target, falling back to INTERNAL_API_TOKEN", () => {
  const c = loadConfig({ ...baseEnv, NODE_ENV: "production", INTERNAL_TOKEN_TO_INTERVIEW: INTERVIEW, INTERNAL_TOKEN_TO_LABS: LABS });
  assert.deepEqual(c.internalTokenTo, { interview: INTERVIEW, labs: LABS, reasoning: RAW });
  const d = loadConfig({ ...baseEnv, NODE_ENV: "development" });
  assert.deepEqual(d.internalTokenTo, { interview: RAW, labs: RAW, reasoning: RAW });
});
