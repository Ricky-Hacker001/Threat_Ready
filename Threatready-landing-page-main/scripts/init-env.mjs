#!/usr/bin/env node
/**
 * Creates apps/api/.env from .env.example (if missing) and fills in random
 * BETTER_AUTH_SECRET and INTERNAL_API_TOKEN values. Safe to run repeatedly;
 * never overwrites a real secret. INTERNAL_API_TOKEN must then be copied to
 * the InterviewPrep and Labs .env files (the same value everywhere).
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "apps/api/.env.example");
const env = join(root, "apps/api/.env");

if (!existsSync(env)) {
  copyFileSync(example, env);
  console.log("created apps/api/.env from .env.example");
}

let text = readFileSync(env, "utf8");
let changed = false;
for (const [name, gen] of [
  ["BETTER_AUTH_SECRET", () => randomBytes(48).toString("base64")],
  ["INTERNAL_API_TOKEN", () => randomBytes(32).toString("hex")],
]) {
  const re = new RegExp(`^${name}=(.*)$`, "m");
  const m = text.match(re);
  const current = (m?.[1] ?? "").trim();
  if (current.length < 32 || current.startsWith("replace-with")) {
    const value = gen();
    text = m ? text.replace(re, `${name}=${value}`) : `${text}\n${name}=${value}\n`;
    changed = true;
    console.log(`generated ${name}`);
  }
}
if (changed) writeFileSync(env, text);
else console.log("apps/api/.env already configured");
