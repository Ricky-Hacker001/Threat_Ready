/**
 * Return targets and the one-click sign-out decision (lib/platform.ts). Node strips the types:
 *   node --test apps/web/test/platform.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cameFromPlatform } from "../src/lib/platform.ts";

const HOST = "https://threatready.example";
const HOMES = [`${HOST}/interview-prep`, `${HOST}/labs/`, `${HOST}/ar/`, `${HOST}/app`];

test("single origin: an app's or /app's page signs out at once; the sign-in page and /signout ask", () => {
  const here = `${HOST}/signout?next=x`;
  for (const from of ["/interview-prep/sessions/1", "/labs/", "/labs/redteam/", "/ar/domains/cloud", "/app/profile"]) {
    assert.equal(cameFromPlatform(`${HOST}${from}`, here, [HOST], HOMES), true, from);
  }
  for (const from of ["/", "/?mode=signup", "/signout", "/api/dev/mailbox"]) {
    assert.equal(cameFromPlatform(`${HOST}${from}`, here, [HOST], HOMES), false, from);
  }
});

test("separate hosts: a registered app origin counts (its referrer carries only the origin); anything else asks", () => {
  const here = "http://localhost:5173/signout";
  const origins = ["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"];
  assert.equal(cameFromPlatform("http://localhost:5174/", here, origins, []), true);
  assert.equal(cameFromPlatform("http://localhost:5175/", here, origins, []), true);
  assert.equal(cameFromPlatform("https://evil.example/", here, origins, []), false);
  assert.equal(cameFromPlatform("", here, origins, []), false, "no referrer (stripped or typed in)");
  assert.equal(cameFromPlatform("not a url", here, origins, []), false);
});
