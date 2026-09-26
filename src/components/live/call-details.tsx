"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CpuIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { Mono, PanelHeader } from "@/components/workspace/bits";
import { median, useLive } from "@/lib/live/store";
import { cn } from "@/lib/utils";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right truncate">{children}</dd>
    </div>
  );
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/* Right column: the call itself and the local engine, so a presenter can see
   at a glance that recognition is local, how fast it is, and that both
   microphones are actually being heard. */
export function CallDetails({ className }: { className?: string }) {
  const health = useLive((s) => s.health);
  const phase = useLive((s) => s.phase);
  const callerFrom = useLive((s) => s.callerFrom);
  const startedAt = useLive((s) => s.callStartedAt);
  const endedAt = useLive((s) => s.callEndedAt);
  const delays = useLive((s) => s.delays);
  const levels = useLive((s) => s.levels);
  const mics = useLive((s) => s.mics);
  const micId = useLive((s) => s.micId);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (phase !== "active") return;
    const t = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const mid = median(delays);
  const elapsed = startedAt === null ? null : (phase === "active" ? now || startedAt : endedAt ?? startedAt) - startedAt;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  return (
    <div className={cn("grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 lg:grid-rows-[minmax(0,0.9fr)_minmax(0,1.1fr)]", className)}>
      <section className="min-h-0 overflow-y-auto rounded-lg border border-border bg-card">
        <PanelHeader title="Call" meta={phase === "active" ? "In progress" : phase === "incoming" ? "Ringing" : startedAt ? "Ended" : "Idle"} />
        <dl className="divide-y divide-border px-4 py-1">
          <Row label="Caller">
            <Mono>{callerFrom ?? "None yet"}</Mono>
          </Row>
          <Row label="Duration">
            <Mono>{elapsed === null ? "0:00" : duration(elapsed)}</Mono>
          </Row>
          <Row label="Median delay">
            <Mono>{mid === null ? "n/a" : `${mid.toFixed(1)} s`}</Mono>
          </Row>
          {/* After a call, the input the call really used, which can differ from the selection. */}
          <Row label="Agent microphone">{levels?.agentInput ?? mics.find((m) => m.id === micId)?.label ?? "System default"}</Row>
          {levels && (
            <Row label="Peak levels">
              <Mono>
                Agent {pct(levels.agent)} · Caller {pct(levels.caller)}
              </Mono>
            </Row>
          )}
        </dl>
      </section>
      <section className="min-h-0 overflow-y-auto rounded-lg border border-border bg-card">
        <PanelHeader title="Speech engine" meta="On this Mac">
          <CpuIcon className="size-3.5 text-muted-foreground" />
        </PanelHeader>
        <dl className="divide-y divide-border px-4 py-1">
          <Row label="Model">
            <Mono>whisper {health?.primary ?? "n/a"}</Mono>
          </Row>
          <Row label="Hardware">{health?.gpu ? "Apple GPU (Metal)" : "CPU"}</Row>
          <Row label="Speech detection">{health?.vad ? "On" : "Off"}</Row>
          <Row label="Cloud transcription">None</Row>
        </dl>
        <p className="flex items-start gap-2 px-4 pb-4 pt-2 text-xs text-muted-foreground leading-relaxed">
          <ShieldCheckIcon className="size-3.5 shrink-0 mt-0.5" />
          Call audio is processed in memory and discarded. The transcript lives only in this tab.
        </p>
      </section>
    </div>
  );
}
