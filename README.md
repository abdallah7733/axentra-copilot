# Axentra Agent Copilot

**Live: https://abdallah7733.github.io/axentra-copilot/**

Graduation project MVP: an enterprise AI copilot that works alongside a customer experience agent on a live call. One real scenario (a duplicate payment refund at the fictional AtlasOne Communications), built end to end.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing page with a live, auto-cycling instance of the product as the hero visual |
| `/demo` | Interactive Demo Mode. Drive every step with Next, or Auto-play. Alternate paths: failed verification, account lock, customer disputes the charge |
| `/presentation` | Product Experience. Clicker-driven scene timeline for the 1-minute recording. Pauses indefinitely at the human approval step. Space, arrows, R, F |
| `/sop` | The billing SOP the copilot cites |
| `/live` | Live call mode for the presenter's Mac: a real call through the demo line, transcribed locally, with the Milestone 3 rules copilot (Sunlake Electronics, CS-SOP-3.1). Includes an offline replay for rehearsal. On the public site it shows a note instead |

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:3000. `npm run build && npm start` for production.

`npm test` runs the copilot unit tests in `src/lib/copilot` with Node's built-in test runner (Node 22.18 or later). `npm run typecheck` generates Next's route types and runs `tsc`; `npm run lint` runs ESLint.

## Architecture

- Next.js App Router, Tailwind v4, shadcn/ui (Radix), `motion/react`, Zustand, Phosphor icons, Geist and Geist Mono via `next/font`.
- `src/lib/demo-data.ts` holds the scenario, SOP, transcript, and workflow. Nothing is hardcoded in components.
- `src/lib/store.ts` is the state machine: `idle → incoming_call → … → resolved` plus branches. Interactive Demo and Presentation Mode drive the same store; the landing hero runs its own instance.
- `src/components/workspace/*` is the four-zone Agent Workspace, rendered identically on `/demo` and `/presentation`.
- Brand assets in `public/brand/`. The wordmark is used exactly as supplied (`src/components/brand/wordmark.tsx`).

## Recording

Open `/presentation` at 1920×1080, press F for fullscreen, then Start. The control bar hides after two seconds without mouse movement. At the approval scene the dialog opens on its own; click Approve to continue.

## Exporting the video (for audio sync)

```bash
scripts/export-video.sh
```

Records Presentation Mode headlessly (Playwright, 1920×1080) from the title card through the outro, clicks Approve at the 5-second audio slot, encodes H.264 at 30 fps, then muxes in `public/audio/call.mp3` (offset to the call scene) and the ambient bed. Output: `exports/axentra-demo.mp4`. Needs a running server on port 3000 and `npx playwright install chromium` once.

## Checks on pull requests

`.github/workflows/checks.yml` runs on every pull request and on `main` after a
merge: unit tests, type check, lint, the local console build (`/console`) and
the public site build (`/axentra-copilot`). On a pull request it tests the
merge of the PR's latest commit into `main`, and a new push re-runs it. It has
read-only permissions and uses no secrets; deployment stays in `deploy.yml`.

**GitHub enforces this.** The branch ruleset "main checks" on `main` requires
the "Tests, types, lint and both builds" check to pass on a branch that is up
to date with `main`. It also blocks force pushes and deleting `main`, and its
bypass list is empty. A pull request with a red or still-running check shows
as blocked and can't be merged. A push straight to `main` is also refused
unless that exact commit already passed the check.

Limits: the repository admin can still edit or switch off the ruleset, so it
guards against mistakes, not against a deliberate override. If the job's
name in `checks.yml` changes, the ruleset must be updated too, or every merge
will wait for a check that never reports. The site deploy (`deploy.yml`)
doesn't wait for the check; it runs on every push to `main`.


Every push to `main` rebuilds and republishes the site through
`.github/workflows/deploy.yml`. It runs `npm run build:static`, which produces a
plain folder of HTML, CSS, JS and audio in `out/` with no server needed.

`NEXT_PUBLIC_BASE_PATH` is set to `/axentra-copilot` in the workflow because
GitHub Pages serves project sites from a subdirectory. next/link and next/font
apply it automatically; anything fetched directly goes through `asset()` in
`src/lib/base-path.ts`. On a host that serves from the domain root (Vercel,
Netlify, a custom Axentra domain) leave the variable unset and nothing changes.
