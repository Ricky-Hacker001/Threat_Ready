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
