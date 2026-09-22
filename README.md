# Axentra Agent Copilot

Graduation project MVP: an enterprise AI copilot that works alongside a customer experience agent on a live call. One real scenario (a duplicate payment refund at the fictional AtlasOne Communications), built end to end.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing page with a live, auto-cycling instance of the product as the hero visual |
| `/demo` | Interactive Demo Mode. Drive every step with Next, or Auto-play. Alternate paths: failed verification, account lock, customer disputes the charge |
| `/presentation` | Product Experience. Clicker-driven scene timeline for the 1-minute recording. Pauses indefinitely at the human approval step. Space, arrows, R, F |
| `/sop` | The billing SOP the copilot cites |

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:3000. `npm run build && npm start` for production.

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

Records `/presentation?from=incoming&capture=1` headlessly (Playwright, 1920×1080), clicks Approve at the 5-second audio slot, encodes H.264 at 30 fps, then muxes in `public/audio/call.mp3` and the ambient bed. Output: `exports/axentra-demo.mp4`. Time 0.0 is the "incoming call" scene, the same origin as `docs/call-audio-prompt.md`. Needs a running server on port 3000 and `npx playwright install chromium` once.
