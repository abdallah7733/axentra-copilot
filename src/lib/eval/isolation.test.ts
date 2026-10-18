import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sunlake } from "@/lib/live/sunlake-data";
import { codeFingerprint, B0 } from "./fingerprint";
import { RECORD_MARKERS } from "./records";

/*
  The harness stays out of the product: no app, component or live-call code imports it, and none
  of its fictional records reach the stage pack. Harness checks, not speech results.
*/

const src = new URL("../../", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : [];
  });

test("nothing outside the harness imports it", () => {
  const offenders = files(src)
    .filter((p) => !p.includes(`${join("lib", "eval")}/`))
    .filter((p) => /from\s+["'](@\/lib\/eval|[./]+eval)(\/|["'])/.test(readFileSync(p, "utf8")));
  assert.deepEqual(offenders, []);
});

test("no evaluation record is in the stage pack or its source", () => {
  const stage = readFileSync(join(src, "lib", "live", "sunlake-data.ts"), "utf8");
  for (const marker of RECORD_MARKERS) assert.ok(!stage.includes(marker), marker);
  assert.deepEqual(sunlake.customers.map((c) => c.name), ["Sam Miller"]);
  assert.deepEqual(sunlake.orders.map((o) => o.id), ["427", "398", "527", "247", "472"]);
});

test("the code fingerprint hashes every baseline file", () => {
  const f = codeFingerprint();
  assert.deepEqual(f.files.map((x) => x.path), Object.keys(B0.files));
  for (const x of f.files) assert.match(x.sha256, /^[0-9a-f]{64}$/);
});
