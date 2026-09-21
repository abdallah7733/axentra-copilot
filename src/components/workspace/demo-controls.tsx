"use client";

import { useEffect } from "react";
import { ArrowCounterClockwiseIcon, CaretLeftIcon, CaretRightIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STEPS, stepIndex } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Mono } from "./bits";

/*
  Evaluator controls for Interactive Demo Mode. Next drives the call forward;
  the branch buttons fork into the states that are built but not in the main
  recorded take. Auto-play reuses the same next() the clicker uses.
*/
export function DemoControls() {
  const step = useDemo((s) => s.step);
  const branch = useDemo((s) => s.branch);
  const next = useDemo((s) => s.next);
  const prev = useDemo((s) => s.prev);
  const reset = useDemo((s) => s.reset);
  const failVerification = useDemo((s) => s.failVerification);
  const lockAccount = useDemo((s) => s.lockAccount);
  const flagUnauthorized = useDemo((s) => s.flagUnauthorized);
  const resumeMain = useDemo((s) => s.resumeMain);
  const autoPlay = useDemo((s) => s.autoPlay);
  const setAutoPlay = useDemo((s) => s.setAutoPlay);

  const i = stepIndex(step);
  const atEnd = step === "resolved";
  const inBranch = branch !== "main";

  // Auto-play: same next() as the button, paced for a live walkthrough.
  useEffect(() => {
    if (!autoPlay || inBranch) return;
    if (atEnd || step === "awaiting_human_approval") {
      setAutoPlay(false);
      if (step === "awaiting_human_approval") next();
      return;
    }
    const t = setTimeout(next, 2600);
    return () => clearTimeout(t);
  }, [autoPlay, step, inBranch, atEnd, next, setAutoPlay]);

  const canFail = ["verification_started", "email_verified"].includes(step) && branch === "main";
  const canLock = branch === "verification_failed";
  const canFlag = i >= stepIndex("transactions_loaded") && i < stepIndex("refund_approved") && branch === "main";

  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-4 py-2">
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="rounded-full" onClick={prev} disabled={i === 0 || inBranch}>
          <CaretLeftIcon data-icon="inline-start" /> Back
        </Button>
        <Button size="sm" className="rounded-full" onClick={next} disabled={atEnd || inBranch}>
          {step === "awaiting_human_approval" ? "Open approval" : step === "idle" ? "Start call" : "Next"} <CaretRightIcon data-icon="inline-end" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full"
          onClick={() => setAutoPlay(!autoPlay)}
          disabled={atEnd || inBranch}
        >
          {autoPlay ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          {autoPlay ? "Pause" : "Auto-play"}
        </Button>
        <Button variant="ghost" size="sm" className="rounded-full" onClick={reset}>
          <ArrowCounterClockwiseIcon data-icon="inline-start" /> Reset
        </Button>
        <span className="ml-2 hidden text-xs text-muted-foreground md:inline">
          Step <Mono>{String(i).padStart(2, "0")}</Mono> of <Mono>{String(STEPS.length - 1).padStart(2, "0")}</Mono>
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Alternate paths</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" className={cn("rounded-full", !canFail && !canLock && "opacity-50")} onClick={canLock ? lockAccount : failVerification} disabled={!canFail && !canLock}>
              {canLock ? "Fail again (lock)" : "Fail verification"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Available during the verification steps</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" className={cn("rounded-full", !canFlag && "opacity-50")} onClick={flagUnauthorized} disabled={!canFlag}>
              Customer disputes charge
            </Button>
          </TooltipTrigger>
          <TooltipContent>Available once transactions are loaded</TooltipContent>
        </Tooltip>
        {inBranch && (
          <Button size="sm" className="rounded-full" onClick={resumeMain}>
            Return to main path
          </Button>
        )}
      </div>
    </footer>
  );
}
