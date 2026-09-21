"use client";

import { useEffect, useRef, useState } from "react";
import { DemoStoreProvider, createDemoStore, useDemoStore } from "@/lib/store";
import { CopilotPanel } from "@/components/workspace/copilot-panel";
import { CustomerContext } from "@/components/workspace/customer-context";
import type { Step } from "@/lib/demo-data";

/*
  The hero visual is the real product: two live panels from the workspace,
  running on their own store instance, auto-cycling through the unlock and
  duplicate-detection beats. Non-interactive, scaled to fit.
*/
const CYCLE: { step: Step; ms: number }[] = [
  { step: "verification_started", ms: 1800 },
  { step: "email_verified", ms: 1400 },
  { step: "customer_verified", ms: 2600 },
  { step: "duplicate_detected", ms: 2600 },
  { step: "refund_recommended", ms: 3600 },
];

const FRAME_W = 900;
const FRAME_H = 520;

function Cycler() {
  const store = useDemoStore();
  useEffect(() => {
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      store.getState().setStep(CYCLE[i].step);
      t = setTimeout(() => {
        i = (i + 1) % CYCLE.length;
        tick();
      }, CYCLE[i].ms);
    };
    tick();
    return () => clearTimeout(t);
  }, [store]);
  return null;
}

export function HeroPreview() {
  const [store] = useState(() => createDemoStore());
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / FRAME_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className="relative w-full" style={{ height: FRAME_H * scale }} aria-label="Live preview of the Agent Copilot panels" role="img">
      <div
        className="pointer-events-none absolute left-0 top-0 origin-top-left select-none"
        style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})` }}
        aria-hidden
      >
        <DemoStoreProvider store={store}>
          <Cycler />
          <div className="grid h-full grid-cols-[1.15fr_1fr] gap-3 rounded-lg border border-white/10 bg-white/5 p-3">
            <CopilotPanel compact className="h-full" />
            <CustomerContext compact className="h-full" />
          </div>
        </DemoStoreProvider>
      </div>
    </div>
  );
}
