"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowSquareOutIcon, CheckIcon, WarningIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { atLeast, duplicate, intent, money, sop, stepIndex, stepTitles, workflow, type Step } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Explain, LiveDot, Mono, PanelHeader, ease } from "./bits";

/* Workflow tracker: done / active / future. The active step is the one place
   cyan appears inside this panel. */
function WorkflowList({ step }: { step: Step }) {
  const current = stepIndex(step);
  const firstPending = workflow.findIndex((w) => current < stepIndex(w.step));
  const activeIdx = step === "idle" ? -1 : firstPending;
  return (
    <ol className="grid grid-cols-1 gap-1" aria-label="Workflow">
      {workflow.map((w, i) => {
        const done = current >= stepIndex(w.step);
        const active = i === activeIdx;
        return (
          <li key={w.key} className={cn("flex items-center gap-2.5 rounded-md px-2 py-1 text-[13px] transition-colors", active && "bg-muted")}>
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
                done && "bg-navy border-navy text-white dark:bg-white dark:border-white dark:text-navy",
                active && "border-cyan bg-cyan/15",
                !done && !active && "border-border text-transparent"
              )}
            >
              {done ? <CheckIcon weight="bold" className="size-2.5" /> : active ? <LiveDot active className="size-1.5" /> : null}
            </span>
            <span className={cn(done && "text-foreground", active && "font-medium", !done && !active && "text-muted-foreground/70")}>{w.label}</span>
            {active && <span className="ml-auto text-xs text-muted-foreground truncate">{stepTitles[step]}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function CopilotPanel({ className, compact = false }: { className?: string; compact?: boolean }) {
  const step = useDemo((s) => s.step);
  const branch = useDemo((s) => s.branch);
  const setSop = useDemo((s) => s.setSop);
  const escalated = useDemo((s) => s.escalated);

  const hasIntent = atLeast(step, "intent_detected");
  const listening = step !== "idle" && step !== "resolved";
  const fraud = branch === "unauthorized_transaction";
  const showRecommendation = atLeast(step, "refund_recommended") && !fraud;

  return (
    <Card className={cn("rounded-lg py-0 gap-0 ring-0 border border-border shadow-none min-h-0 flex flex-col", className)}>
      <PanelHeader title="Copilot" meta={listening ? "Listening" : step === "resolved" ? "Standing by" : "Idle"}>
        <LiveDot active={listening} />
      </PanelHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
        {/* Intent + confidence */}
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Intent</span>
            {hasIntent && (
              <span className="inline-flex items-center gap-1.5 text-xs">
                <CheckIcon weight="bold" className="size-3 text-cyan drop-shadow-[0_0_1px_rgb(16_37_66_/_0.6)]" />
                <Mono className="font-medium">{intent.confidence}%</Mono>
                <span className="text-muted-foreground">confidence</span>
              </span>
            )}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            {hasIntent ? (
              <motion.div key="intent" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="mt-1.5 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-navy text-white dark:bg-white dark:text-navy">{intent.label}</Badge>
                  <span className="text-xs text-muted-foreground">{intent.category}</span>
                </div>
                {!compact && (
                  <Explain label="Why this intent">
                    <ul className="list-disc pl-4 space-y-1">
                      {intent.evidence.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </Explain>
                )}
              </motion.div>
            ) : (
              <motion.p key="no-intent" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-1.5 text-sm text-muted-foreground">
                {listening ? "Listening for the customer's request." : "No intent yet."}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Workflow */}
        <div>
          <div className="mb-1.5 text-xs text-muted-foreground">Workflow</div>
          <WorkflowList step={step} />
        </div>

        {/* Recommendation */}
        <AnimatePresence initial={false}>
          {showRecommendation && (
            <motion.div
              key="rec"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease }}
              className="rounded-lg border border-border bg-muted/50 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Recommendation</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {sop.id} Scenario A
                </Badge>
              </div>
              <p className="text-sm leading-snug">
                Refund <Mono className="font-medium">{money(duplicate.amount)}</Mono> for <Mono>{duplicate.duplicateId}</Mono> to the original card. Keep <Mono>{duplicate.original}</Mono>.
              </p>
              {escalated && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <WarningIcon className="size-3.5 mt-0.5 shrink-0" /> Escalated to Team Lead by the agent. Waiting for review.
                </p>
              )}
              {!compact && (
                <>
                  <Explain label="Why a refund, and why this one">
                    <ul className="list-disc pl-4 space-y-1">
                      <li>Same amount, same card, same plan line, {duplicate.gapSeconds} seconds apart. All four Scenario A conditions are met.</li>
                      <li>{money(duplicate.amount)} is inside the $0 to $100 band, so a Tier 1 agent can approve it.</li>
                      <li>The later charge is refunded so the original stays attached to the billing cycle.</li>
                    </ul>
                  </Explain>
                  <Button variant="ghost" size="xs" className="-ml-1 text-muted-blue" onClick={() => setSop(true)}>
                    Open SOP <ArrowSquareOutIcon data-icon="inline-end" />
                  </Button>
                </>
              )}
            </motion.div>
          )}
          {fraud && (
            <motion.div key="fraud" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="rounded-lg border border-border bg-muted/50 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Recommendation changed</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {sop.id} Scenario B
                </Badge>
              </div>
              <p className="text-sm leading-snug">Customer does not recognise <Mono>{duplicate.duplicateId}</Mono>. Place a hold and open a Fraud and Risk case. No refund at agent level.</p>
              {!compact && (
                <Explain label="Why not refund">
                  Scenario A requires the customer to recognise the original charge and the duplicate to be an accidental repeat. An unrecognised charge is treated as potentially unauthorised, which only the Fraud and Risk team can resolve.
                </Explain>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}
