"use client";

import { WaveformIcon } from "@phosphor-icons/react";
import { Card } from "@/components/ui/card";
import { LiveDot, PanelHeader } from "@/components/workspace/bits";
import { useLive } from "@/lib/live/store";
import { cn } from "@/lib/utils";

/*
  Milestone 2 is listening only. The copilot shows that it is hearing the call
  and nothing more: no intent, verification or SOP guidance is simulated here.
  Real assistance arrives with Milestone 3.
*/
export function LiveCopilot({ className }: { className?: string }) {
  const phase = useLive((s) => s.phase);
  const lines = useLive((s) => s.lines);
  const listening = phase === "active";
  const callerLines = lines.filter((l) => l.side === "caller").length;
  const agentLines = lines.length - callerLines;

  return (
    <Card className={cn("rounded-lg py-0 gap-0 ring-0 border border-border shadow-none min-h-0 flex flex-col", className)}>
      <PanelHeader title="Copilot" meta={listening ? "Listening" : "Standing by"}>
        <LiveDot active={listening} />
      </PanelHeader>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
        <div className="flex items-start gap-3">
          <WaveformIcon className={cn("size-5 shrink-0 mt-0.5", listening ? "text-cyan" : "text-muted-foreground")} />
          <div className="space-y-1">
            <p className="text-sm">{listening ? "Hearing both sides of the call." : "Waiting for a call."}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Caller and agent speech are transcribed separately, on this Mac, in real time. No audio or transcript is stored.
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border border-border p-3">
            <dt className="text-muted-foreground">Caller lines</dt>
            <dd className="mt-1 font-mono text-lg">{callerLines}</dd>
          </div>
          <div className="rounded-md border border-border p-3">
            <dt className="text-muted-foreground">Agent lines</dt>
            <dd className="mt-1 font-mono text-lg">{agentLines}</dd>
          </div>
        </dl>
        <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground leading-relaxed">
          Live mode currently covers listening. Intent detection, identity verification and SOP guidance on a live call are the next milestone. The
          scripted walkthrough of the full copilot is in the Interactive Demo.
        </p>
      </div>
    </Card>
  );
}
