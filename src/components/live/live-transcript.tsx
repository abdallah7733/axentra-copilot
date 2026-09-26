"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PhoneIcon } from "@phosphor-icons/react";
import { LiveDot, Mono, PanelHeader, ease } from "@/components/workspace/bits";
import { useLive } from "@/lib/live/store";
import { cn } from "@/lib/utils";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/*
  Real call transcript, same visual language as the scripted Transcript panel:
  flat, divide-y between turns, monospace timestamps. Text comes from speech
  recognition running on this Mac; nothing is stored.
*/
export function LiveTranscript({ className }: { className?: string }) {
  const lines = useLive((s) => s.lines);
  const phase = useLive((s) => s.phase);
  const callerFrom = useLive((s) => s.callerFrom);
  const callStartedAt = useLive((s) => s.callStartedAt);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines.length]);

  const live = phase === "active";
  const meta = live ? "Connected" : phase === "incoming" ? "Ringing" : lines.length ? "Call ended" : "No active call";

  return (
    <section className={cn("flex flex-col min-h-0 bg-card border border-border rounded-none", className)} aria-label="Live call transcript">
      <PanelHeader title="Live call" meta={meta}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LiveDot active={live} />
          <PhoneIcon className="size-3.5" />
          <Mono>{callerFrom ?? "No caller"}</Mono>
        </div>
      </PanelHeader>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="h-full flex items-center justify-center p-8 text-center text-sm text-muted-foreground">
            {live ? "Listening to both sides of the call." : "Waiting for the next call. Speech is transcribed on this Mac."}
          </div>
        ) : (
          <ol className="divide-y divide-border">
            <AnimatePresence initial={false}>
              {lines.map((t) => (
                <motion.li
                  key={t.key}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease }}
                  className="grid grid-cols-[3.25rem_4.5rem_1fr] gap-x-2 px-4 py-2.5 text-[13px] leading-relaxed"
                >
                  <Mono className="text-muted-foreground pt-px">{callStartedAt === null ? "--:--" : clock(t.startedAt - callStartedAt)}</Mono>
                  <span className={cn("font-medium", t.side === "agent" ? "text-foreground" : "text-foreground/80")}>
                    {t.side === "agent" ? "Agent" : "Caller"}
                  </span>
                  <div>
                    <p>{t.text}</p>
                    <p className="text-[11px] text-muted-foreground">
                      <Mono>{t.delay.toFixed(1)} s</Mono> after speech ended
                      {t.confidence !== null && t.confidence < 0.6 && <span> · low confidence</span>}
                    </p>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
