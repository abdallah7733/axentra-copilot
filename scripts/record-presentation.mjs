// Records Presentation Mode headlessly at 1920x1080 and writes exports/presentation.webm
// plus exports/presentation.json (trim offset in ms so the file can start at the
// "incoming" scene, where the call audio starts).
//
//   node scripts/record-presentation.mjs [baseUrl]
//
// Requires a running dev or prod server (default http://localhost:3000).
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = "exports";
const TMP = join(OUT, ".rec");
const APPROVAL_SLOT_MS = 5000; // must match APPROVAL_AUDIO_SLOT_MS in src/lib/store.ts
const APPROVE_DELAY_AFTER_CLICK_MS = 1200; // player waits this long after Approve before the next scene

mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  recordVideo: { dir: TMP, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
const videoStartedAt = Date.now();

await page.goto(`${BASE}/presentation?from=incoming&capture=1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-scene="incoming"]', { timeout: 15000 });
const sceneStartedAt = Date.now();
console.log("incoming scene started", sceneStartedAt - videoStartedAt, "ms into the recording");

// Approval scene: click Approve so that the next scene starts exactly APPROVAL_SLOT_MS after the scene began.
await page.waitForSelector('[data-scene="approval"]', { timeout: 120000 });
const approvalAt = Date.now();
const approveBtn = page.getByRole("button", { name: /^Approve \$49\.00 refund$/ });
await approveBtn.waitFor({ state: "visible", timeout: 10000 });
const clickAt = approvalAt + APPROVAL_SLOT_MS - APPROVE_DELAY_AFTER_CLICK_MS;
await page.waitForTimeout(Math.max(0, clickAt - Date.now()));
await approveBtn.click();
console.log("approved at", Date.now() - approvalAt, "ms into the approval scene");

// Run through the outro, then a beat of the final frame.
await page.waitForSelector('[data-scene="outro"]', { timeout: 120000 });
await page.waitForTimeout(4600);
const endedAt = Date.now();

await page.close();
await context.close();
await browser.close();

const webm = readdirSync(TMP).find((f) => f.endsWith(".webm"));
renameSync(join(TMP, webm), join(OUT, "presentation.webm"));
rmSync(TMP, { recursive: true, force: true });
const meta = {
  trimMs: sceneStartedAt - videoStartedAt,
  durationMs: endedAt - sceneStartedAt,
  recordedAt: new Date().toISOString(),
};
writeFileSync(join(OUT, "presentation.json"), JSON.stringify(meta, null, 2));
console.log("wrote exports/presentation.webm", meta);
