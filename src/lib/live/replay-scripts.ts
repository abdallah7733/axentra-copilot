import type { ReplayLine } from "./store";
import { scriptV2 } from "./sunlake-data";

/*
  Offline replays for rehearsal: script v2 (content doc §5), the mis-heard order
  numbers from real calls (§6) and the test branches (§7). They go through the same
  event path as a call, with no phone, audio or speech engine involved.
*/

const LINE2 = "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.";

/** Script v2 with some lines (by number) replaced, or dropped with null. */
const variant = (replace: Record<number, ReplayLine | null>): ReplayLine[] =>
  scriptV2.flatMap((l) => (l.n in replace ? (replace[l.n] ? [replace[l.n]!] : []) : [{ side: l.side, text: l.text }]));

export const replayScripts: { id: string; label: string; lines: ReplayLine[] }[] = [
  { id: "main", label: "Script v2", lines: variant({}) },
  { id: "4to7", label: 'Heard "4 to 7"', lines: variant({ 2: { side: "caller", text: LINE2.replace("427", "4 to 7") } }) },
  { id: "527", label: 'Heard "527"', lines: variant({ 2: { side: "caller", text: LINE2.replace("427", "527"), confidence: 0.55 } }) },
  { id: "nonumber", label: "No order number", lines: variant({ 2: { side: "caller", text: "Hello. The tablet came yesterday, and the screen is cracked." } }) },
  {
    id: "chargeback",
    label: "Branch: chargeback",
    lines: variant({ 9: { side: "caller", text: "This is the second time. If it happens again, I will call my bank for a chargeback." }, 10: null, 11: null, 12: null }),
  },
  { id: "safety", label: "Branch: safety", lines: variant({ 9: { side: "caller", text: "Also, the tablet is getting very hot." }, 10: null, 11: null, 12: null }) },
  {
    id: "refund",
    label: "Branch: refund",
    lines: variant({
      9: { side: "caller", text: "I just want my money back." },
      10: null,
      11: null,
      12: { side: "agent", text: "Done. Your refund is set up. You'll get an email with a free return label for the damaged one." },
    }),
  },
  { id: "failed", label: "Branch: failed check", lines: variant({ 7: { side: "caller", text: "Lake Road, in Houston." } }).slice(0, 7) },
];
