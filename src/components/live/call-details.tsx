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

/* How long the name took: from the end of the caller's first name answer to the accepted name, and how it was
   accepted (read back, typed, confirmed by the agent or recognised), to compare the read-back with typing (22 Oct).
   Both routes start at the same point; typing stops at the keystroke, the read-back at the caller's checked yes. */
function NameTiming() {
  const name = useCopilot((s) => s.view.verification.factors[0]);
  if (name.state !== "ok" || name.answeredAt === undefined || name.knownAt === undefined) return null;
  const method = name.method ?? "";
  const route = method.startsWith("name read back") ? "read back" : method.includes("typed") ? "typed" : method.startsWith("confirmed") ? "confirmed by you" : "recognised";
  return (
    <Row label="Name accepted">
      <Mono>
        {Math.max(0, (name.knownAt - name.answeredAt) / 1000).toFixed(1)} s after the first name answer ended · {route}
      </Mono>
    </Row>
  );
}

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
  const lines = useLive((s) => s.lines);
  const levels = useLive((s) => s.levels);
  const mics = useLive((s) => s.mics);
  const micId = useLive((s) => s.micId);
  const replaying = useLive((s) => s.replaying);
  const dropped = useLive((s) => s.dropped);
  const assistTimes = useCopilot((s) => s.assistTimes);
  const assistLog = useCopilot((s) => s.assistLog);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (phase !== "active" && !replaying) return;
    const t = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(t);
  }, [phase, replaying]);

  const mid = median(delays);
  // Checked answers: from the end of speech to the checked text, which is when the copilot can use it.
  // Read-back hearings (probes) hold nothing back, so they don't count here.
  const checked = lines.filter((l) => l.checkSeconds !== undefined && !l.checkFailed && !l.probe).map((l) => (l.availableAtEpoch - l.endedAtEpoch) / 1000);
  const notChecked = lines.filter((l) => !l.probe && (l.checkFailed || l.checkSkipped)).length;
  const checkedMid = median(checked);
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
          <Row label="First text">
            <Mono>{mid === null ? "n/a" : `${mid.toFixed(1)} s median`}</Mono>
          </Row>
          <Row label="Checked answers">
            <Mono>
              {checkedMid === null ? "none yet" : `${checkedMid.toFixed(1)} s median (${checked.length})`}
              {notChecked > 0 && ` · ${notChecked} not checked`}
            </Mono>
          </Row>
          <NameTiming />
          {/* Speech that never became a line. Zero is the expected value; a count means words may be missing. */}
          <Row label="Phrases with no text">
            <Mono>
              {(["agent", "caller"] as const)
                .map((side) => {
                  const { short, empty } = dropped[side];
                  const parts = [short && `${short} too short`, empty && `${empty} no words`].filter(Boolean).join(", ");
                  return `${side === "agent" ? "Agent" : "Caller"} ${short + empty}${parts ? ` (${parts})` : ""}`;
                })
                .join(" · ")}
            </Mono>
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
          {/* A build setting (NEXT_PUBLIC_NAME_READ_BACK), so a recording shows which rules it ran. */}
          <Row label="Name read-back">{pack.policy.nameReadBack ? "On (this build)" : "Off"}</Row>
          <Row label="Address read-back">{pack.policy.addressReadBack ? "On (this build)" : "Off"}</Row>
          {health?.assist === "local" && (
            <>
              <Row label="Local model">
                {health.assistModel === "qwen15b" ? "Qwen 2.5 1.5B" : "Llama 3.2 3B"} ({health.assistGpu ? "GPU" : "CPU"}){health.assistReady ? "" : ", loading"}
              </Row>
              <Row label="Suggestion time">
                <Mono>
                  {median(assistTimes) === null ? "n/a" : `${(median(assistTimes)! / 1000).toFixed(1)} s median (${assistTimes.length})`}
                  {(["rejected", "late", "timeout"] as const).map((outcome) => {
                    const count = assistLog.filter((r) => r.outcome === outcome).length;
                    return count ? ` · ${count} ${outcome === "timeout" ? "timed out" : outcome}` : "";
                  })}
                </Mono>
              </Row>
            </>
          )}
          <Row label="Cloud AI">None</Row>
          {/* Ties a recording to the code it ran. */}
          <Row label="Console build">
            <Mono>
              {process.env.NEXT_PUBLIC_BUILD_COMMIT || "development"}
              {process.env.NEXT_PUBLIC_CONSOLE_CHANNEL === "development" ? ", development console" : ""}
            </Mono>
          </Row>
        </dl>
        <p className="flex items-start gap-2 px-4 pb-4 pt-2 text-xs text-muted-foreground leading-relaxed">
          <ShieldCheckIcon className="size-3.5 shrink-0 mt-0.5" />
          Call audio is processed in memory and discarded. The transcript and copilot notes live only in this tab.
        </p>
      </section>
    </div>
  );
}
