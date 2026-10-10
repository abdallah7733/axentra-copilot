"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CpuIcon, LockSimpleIcon, LockSimpleOpenIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { Mono, PanelHeader } from "@/components/workspace/bits";
import { pack, useCopilot } from "@/lib/live/copilot-store";
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

/* The customer record the caller ID points to. Caller ID matching is simulated in
   this demo (every call is the demo customer), and the record stays locked until
   the caller passes the SOP identity check by voice. */
function CustomerRecord() {
  const verification = useCopilot((s) => s.view.verification);
  const lineCount = useCopilot((s) => s.view.lineCount);
  const customer = pack.customers.find((c) => c.id === pack.callerCustomerId)!;
  const open = verification.verified;
  return (
    <section className="rounded-lg border border-border bg-card">
      <PanelHeader title="Customer" meta={open ? "Verified" : verification.locked ? "Not verified" : lineCount ? "Checking identity" : "Caller ID match (simulated)"}>
        {open ? <LockSimpleOpenIcon className="size-3.5 text-muted-foreground" /> : <LockSimpleIcon className="size-3.5 text-muted-foreground" />}
      </PanelHeader>
      {open ? (
        <dl className="divide-y divide-border px-4 py-1">
          <Row label="Name">{customer.name}</Row>
          <Row label="Customer">
            <Mono>{customer.id}</Mono>
          </Row>
          <Row label="Email">
            <Mono>{customer.emailMasked}</Mono>
          </Row>
          <Row label="Delivery">
            {customer.address.street}, {customer.address.city}, {customer.address.state}
          </Row>
          <Row label="Since">{customer.customerSince}</Row>
          <Row label="Damage claims, 90 days">
            <Mono>{customer.damageClaimsLast90Days}</Mono>
          </Row>
        </dl>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground leading-relaxed">
          {verification.locked
            ? "Identity not verified after two attempts. Offer a call back to the phone number on the order."
            : `Details and orders unlock after the ${pack.sop.id} identity check: full name, then the email or the delivery street and city.`}
        </p>
      )}
    </section>
  );
}

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
  const replaying = useLive((s) => s.replaying);
  const assistTimes = useCopilot((s) => s.assistTimes);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (phase !== "active" && !replaying) return;
    const t = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(t);
  }, [phase, replaying]);

  const mid = median(delays);
  const running = phase === "active" || replaying;
  const elapsed = startedAt === null ? null : (running ? Math.max(now, startedAt) : endedAt ?? startedAt) - startedAt;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  return (
    <div className={cn("flex min-h-0 flex-col gap-3 lg:overflow-y-auto", className)}>
      <section className="rounded-lg border border-border bg-card">
        <PanelHeader title="Call" meta={replaying ? "Replay, no call" : phase === "active" ? "In progress" : phase === "incoming" ? "Ringing" : startedAt ? "Ended" : "Idle"} />
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
      <CustomerRecord />
      <section className="rounded-lg border border-border bg-card">
        <PanelHeader title="Speech and copilot" meta="On this Mac">
          <CpuIcon className="size-3.5 text-muted-foreground" />
        </PanelHeader>
        <dl className="divide-y divide-border px-4 py-1">
          <Row label="Model">
            <Mono>whisper {health?.primary ?? "n/a"}</Mono>
          </Row>
          <Row label="Hardware">{health?.gpu ? "Apple GPU (Metal)" : "CPU"}</Row>
          <Row label="Speech detection">{health?.vad ? "On" : "Off"}</Row>
          <Row label="Key answers checked by">{health?.check ? <Mono>whisper {health.checkModel ?? "large-v3-turbo"}</Mono> : "Off"}</Row>
          <Row label="Copilot">Rules ({pack.sop.id})</Row>
          {health?.assist === "local" && (
            <>
              <Row label="Local model">
                {health.assistModel === "qwen15b" ? "Qwen 2.5 1.5B" : "Llama 3.2 3B"} ({health.assistGpu ? "GPU" : "CPU"}){health.assistReady ? "" : ", loading"}
              </Row>
              <Row label="Suggestion time">
                <Mono>{median(assistTimes) === null ? "n/a" : `${(median(assistTimes)! / 1000).toFixed(1)} s median`}</Mono>
              </Row>
            </>
          )}
          <Row label="Cloud AI">None</Row>
        </dl>
        <p className="flex items-start gap-2 px-4 pb-4 pt-2 text-xs text-muted-foreground leading-relaxed">
          <ShieldCheckIcon className="size-3.5 shrink-0 mt-0.5" />
          Call audio is processed in memory and discarded. The transcript and copilot notes live only in this tab.
        </p>
      </section>
    </div>
  );
}
