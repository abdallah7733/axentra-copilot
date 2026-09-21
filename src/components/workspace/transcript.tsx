"use client";

import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PhoneIcon } from "@phosphor-icons/react";
import { branchTranscript, company, customer, stepIndex, transcript, type Speaker } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LiveDot, Mono, PanelHeader, ease } from "./bits";

const speakerLabel: Record<Speaker, string> = { agent: company.agent.name.split(" ")[0], customer: customer.name.split(" ")[0], system: "Copilot" };

/*
  Live call transcript. Deliberately not a chat: flat panel, zero radius,
  divide-y between turns, monospace timestamps.
*/
export function Transcript({ className }: { className?: string }) {
  const step = useDemo((s) => s.step);
  const branch = useDemo((s) => s.branch);
  const endRef = useRef<HTMLDivElement>(null);

  const turns = useMemo(() => {
    const current = stepIndex(step);
    const main = transcript.filter((t) => stepIndex(t.step) <= current);
    if (branch === "main") return main;
    const extra = branch === "account_locked" ? [...branchTranscript.verification_failed, ...branchTranscript.account_locked] : branchTranscript[branch];
    return [...main, ...extra];
  }, [step, branch]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length]);

  const live = step !== "idle" && step !== "resolved";

  return (
    <section className={cn("flex flex-col min-h-0 bg-card border border-border rounded-none", className)} aria-label="Live call transcript">
      <PanelHeader title="Live call" meta={live ? "Connected" : step === "resolved" ? "Call ended" : "No active call"}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LiveDot active={live} />
          <PhoneIcon className="size-3.5" />
          <Mono>{customer.phoneMasked}</Mono>
        </div>
      </PanelHeader>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {turns.length === 0 ? (
          <div className="h-full flex items-center justify-center p-8 text-center text-sm text-muted-foreground">
            Waiting for the next call. The copilot joins automatically.
          </div>
        ) : (
          <ol className="divide-y divide-border">
            <AnimatePresence initial={false}>
              {turns.map((t, i) => (
                <motion.li
                  key={`${t.time}-${i}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease }}
                  className={cn("grid grid-cols-[3.25rem_4.5rem_1fr] gap-x-2 px-4 py-2.5 text-[13px] leading-relaxed", t.speaker === "system" && "bg-muted/60")}
                >
                  <Mono className="text-muted-foreground pt-px">{t.time}</Mono>
                  <span className={cn("font-medium", t.speaker === "system" ? "text-muted-blue" : t.speaker === "agent" ? "text-foreground" : "text-foreground/80")}>
                    {speakerLabel[t.speaker]}
                  </span>
                  <p className={cn(t.speaker === "system" && "text-muted-foreground")}>{t.text}</p>
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
