"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowSquareOutIcon, CheckCircleIcon, CheckIcon, LockSimpleIcon, PackageIcon, QuotesIcon, ShieldWarningIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Explain, LiveDot, Mono, PanelHeader, ease } from "@/components/workspace/bits";
import type { Alert, Evidence, SopStep } from "@/lib/copilot/copilot";
import { money } from "@/lib/demo-data";
import { pack, useCopilot } from "@/lib/live/copilot-store";
import { useLive } from "@/lib/live/store";
import { cn } from "@/lib/utils";

/*
  The live copilot panel. Everything here comes from the rules in src/lib/copilot,
  computed from the call's transcript events and Sunlake's SOP and order data. It
  suggests; the agent decides. Nothing is executed or sent.
*/

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** A quoted transcript line. Hovering it highlights the line in the transcript. */
function Quote({ ev, className }: { ev: Evidence; className?: string }) {
  const setHighlight = useCopilot((s) => s.setHighlight);
  const callStartedAt = useLive((s) => s.callStartedAt);
  const startEpoch = callStartedAt === null ? null : performance.timeOrigin + callStartedAt;
  return (
    <span
      className={cn("inline-flex items-baseline gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground cursor-default", className)}
      onMouseEnter={() => setHighlight(ev.key)}
      onMouseLeave={() => setHighlight(null)}
    >
      <QuotesIcon className="size-3 shrink-0 translate-y-0.5" />
      <span>
        &ldquo;{ev.text}&rdquo; <span className="whitespace-nowrap">{ev.side === "agent" ? "Agent" : "Caller"}{startEpoch !== null && <> <Mono>{clock(ev.at - startEpoch)}</Mono></>}</span>
        {ev.lowConfidence && <span> · low confidence</span>}
      </span>
    </span>
  );
}

function Section({ label, meta, children }: { label: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        {meta}
      </div>
      {children}
    </div>
  );
}

function StepIcon({ status }: { status: SopStep["status"] }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
        status === "done" && "bg-navy border-navy text-white dark:bg-white dark:border-white dark:text-navy",
        status === "active" && "border-cyan bg-cyan/15",
        status === "attention" && "border-amber-500 bg-amber-500/15 text-amber-600",
        status === "blocked" && "border-destructive text-destructive",
        (status === "pending" || status === "skipped") && "border-border text-transparent"
      )}
    >
      {status === "done" ? <CheckIcon weight="bold" className="size-2.5" /> : status === "active" ? <LiveDot active className="size-1.5" /> : status === "attention" ? "!" : status === "blocked" ? <XIcon weight="bold" className="size-2.5" /> : null}
    </span>
  );
}

function Steps({ steps }: { steps: SopStep[] }) {
  const setHighlight = useCopilot((s) => s.setHighlight);
  return (
    <ol className="grid grid-cols-1 gap-0.5" aria-label="SOP steps">
      {steps.map((s) => (
        <li
          key={s.id}
          title={s.evidence ? `“${s.evidence.text}” (${s.sopRef})` : s.sopRef}
          onMouseEnter={() => s.evidence && setHighlight(s.evidence.key)}
          onMouseLeave={() => setHighlight(null)}
          className={cn("flex items-center gap-2.5 rounded-md px-2 py-1 text-[13px] transition-colors", s.status === "active" && "bg-muted")}
        >
          <StepIcon status={s.status} />
          <span className={cn(s.status === "done" && "text-foreground", s.status === "active" && "font-medium", (s.status === "pending" || s.status === "skipped") && "text-muted-foreground/70", s.status === "skipped" && "line-through")}>
            {s.label}
          </span>
          {s.detail && <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

function AlertCard({ alert }: { alert: Alert }) {
  const danger = alert.level === "danger" && !alert.resolved;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease }}
      className={cn(
        "rounded-lg border p-3 space-y-1.5",
        alert.resolved ? "border-border bg-transparent opacity-70" : danger ? "border-destructive/60 bg-destructive/5" : "border-amber-500/60 bg-amber-500/5"
      )}
    >
      <div className="flex items-start gap-2">
        {alert.resolved ? (
          <CheckCircleIcon className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
        ) : danger ? (
          <ShieldWarningIcon className="size-4 shrink-0 mt-0.5 text-destructive" />
        ) : (
          <WarningIcon className="size-4 shrink-0 mt-0.5 text-amber-600" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium leading-snug">{alert.title}</p>
          <p className="text-xs leading-relaxed">{alert.resolved ?? alert.detail}</p>
          {alert.evidence.slice(0, 2).map((ev) => (
            <Quote key={ev.key} ev={ev} className="flex" />
          ))}
        </div>
        <Mono className="shrink-0 text-[10px] text-muted-foreground">{alert.sopRef.replace(`${pack.sop.id} · `, "")}</Mono>
      </div>
    </motion.div>
  );
}

export function LiveCopilot({ className }: { className?: string }) {
  const phase = useLive((s) => s.phase);
  const replaying = useLive((s) => s.replaying);
  const setSop = useLive((s) => s.setSop);
  const view = useCopilot((s) => s.view);
  const lastMs = useCopilot((s) => s.lastMs);
  const confirm = useCopilot((s) => s.confirm);
  const approve = useCopilot((s) => s.approve);
  const assist = useCopilot((s) => s.assist);
  const worded = useCopilot((s) => s.worded);
  const listening = phase === "active" || replaying;
  const { intent, order, recommendation: rec, suggestedReply, alerts, prompts, steps, checks, verification } = view;
  const match = order.match;
  const openAlerts = alerts.filter((a) => !a.resolved);
  const resolvedAlerts = alerts.filter((a) => a.resolved);

  return (
    <Card className={cn("rounded-lg py-0 gap-0 ring-0 border border-border shadow-none min-h-0 flex flex-col", className)}>
      <PanelHeader title="Copilot" meta={listening ? "Listening" : view.lineCount ? "Call ended" : "Standing by"}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground" title="Eligibility, amounts and escalation come from the SOP rules and order data">
            {assist === "off" ? "Rules" : "Rules + local model"} on this Mac{lastMs !== null && view.lineCount > 0 && <> · <Mono>{lastMs < 1 ? "<1" : lastMs.toFixed(0)} ms</Mono></>}
          </span>
          <LiveDot active={listening} />
        </div>
      </PanelHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
        {/* Intent */}
        <Section
          label="Intent"
          meta={
            intent && (
              <span className="inline-flex items-center gap-1.5">
                {intent.certainty === "low" ? (
                  <span className="text-amber-600">Low certainty: confirm with the caller</span>
                ) : (
                  <>
                    <Mono className="font-medium text-foreground">{Math.round(intent.confidence * 100)}%</Mono> confidence
                  </>
                )}
              </span>
            )
          }
        >
          <AnimatePresence mode="wait" initial={false}>
            {intent ? (
              <motion.div key={intent.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-navy text-white dark:bg-white dark:text-navy">{intent.label}</Badge>
                  <span className="text-xs text-muted-foreground">{intent.sopId ? <>SOP <Mono>{intent.sopId}</Mono></> : "No SOP for this in the client pack"}</span>
                </div>
                <Explain label="Why this intent">
                  <ul className="list-disc pl-4 space-y-1">
                    <li>Phrases heard: {intent.phrases.map((p) => `“${p}”`).join(", ")}</li>
                    {intent.evidence.map((ev) => (
                      <li key={ev.key}>
                        <Quote ev={ev} />
                      </li>
                    ))}
                  </ul>
                </Explain>
              </motion.div>
            ) : (
              <motion.p key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-sm text-muted-foreground">
                {listening ? "Listening for the caller's problem." : "Waiting for a call."}
              </motion.p>
            )}
          </AnimatePresence>
        </Section>

        {/* Alerts and please-confirm prompts come first: they are what the agent must act on now. */}
        {(openAlerts.length > 0 || prompts.length > 0) && (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {openAlerts.map((a) => (
                <AlertCard key={a.id} alert={a} />
              ))}
            </AnimatePresence>
            {prompts.map((p) => (
              // Amber and pulsing: on the first live call the agent only noticed this after hanging up.
              <motion.div
                key={`${p.target}-${p.evidence?.key}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease }}
                className="flex items-start gap-2.5 rounded-lg border-2 border-amber-500 bg-amber-500/10 p-3"
              >
                <LiveDot active className="mt-1 [&>span]:bg-amber-500" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">Please confirm</p>
                  <p className="text-xs leading-relaxed">{p.text}</p>
                </div>
                <Button size="sm" className="rounded-full bg-amber-600 text-white hover:bg-amber-700" onClick={() => confirm(p.target)}>
                  Confirmed
                </Button>
              </motion.div>
            ))}
          </div>
        )}

        {/* Suggested reply: wording only, never sent */}
        {suggestedReply && (
          <Section label="Suggested reply" meta={<Mono className="text-[10px]">{suggestedReply.sopRef}</Mono>}>
            {(() => {
              const byModel = worded && worded.draft === suggestedReply.text ? worded : null;
              return (
                <>
                  <p className="rounded-md border-l-2 border-cyan bg-muted/40 px-3 py-2 text-sm leading-relaxed">{byModel ? byModel.text : suggestedReply.text}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {byModel
                      ? `Worded by the local model in ${(byModel.ms / 1000).toFixed(1)} s; facts and offers checked against the SOP rules. You decide what to say.`
                      : assist === "working"
                        ? "From the SOP rules. The local model is rewording it…"
                        : assist === "fallback"
                          ? "From the SOP rules (the local model was slow or unavailable). You decide what to say."
                          : "A suggestion from the SOP rules. You decide what to say."}
                  </p>
                </>
              );
            })()}
          </Section>
        )}

        {/* Recommendation */}
        <AnimatePresence initial={false}>
          {rec && (
            <motion.div
              key={`rec-${rec.scenario}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease }}
              className={cn("rounded-lg border p-3 space-y-2", rec.scenario === "C" ? "border-destructive/60 bg-destructive/5" : "border-border bg-muted/50")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Recommendation</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {pack.sop.id} Scenario {rec.scenario}
                  {rec.alsoAllowed && ` or ${rec.alsoAllowed}`}
                </Badge>
              </div>
              <p className="text-sm font-medium leading-snug">{rec.title}</p>
              <p className="text-sm leading-snug">{rec.action}</p>
              {rec.alsoAllowed && <p className="text-xs text-muted-foreground">The customer asked about both options. Scenario B (refund) is also allowed.</p>}
              <p className="text-xs text-muted-foreground">
                Approver: {rec.approver}
                {rec.agentCanApprove ? ". You can approve this." : ". You can't approve this."}
              </p>
              <Explain label="Why">
                <ul className="list-disc pl-4 space-y-1">
                  {rec.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                  {rec.evidence.map((ev) => (
                    <li key={ev.key}>
                      <Quote ev={ev} />
                    </li>
                  ))}
                  <li>
                    Rule: <Mono>{rec.sopRef}</Mono>
                  </li>
                </ul>
              </Explain>
              {rec.prepared && (
                <div className="rounded-md border border-border bg-card p-2.5 space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">Prepared {rec.prepared.kind === "replacement" ? "replacement" : "refund"}</span>
                    <Mono>{rec.prepared.reference}</Mono>
                  </div>
                  <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">
                    {rec.prepared.lines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  {rec.approval.state === "approved" ? (
                    <p className="flex items-center gap-1.5 pt-1 text-xs">
                      <CheckCircleIcon className="size-3.5 text-cyan" /> Approved by {rec.approval.by}
                      {rec.approval.via === "call" ? " on the call" : ""}. Nothing is sent in this demo.
                    </p>
                  ) : (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-xs text-muted-foreground">Waiting for your approval.</span>
                      <Button size="xs" className="rounded-full" onClick={approve}>
                        Approve
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Order: only what was heard until identity is verified. */}
        <Section label="Order">
          {match ? (
            <div className="rounded-md border border-border p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <PackageIcon className="size-4 text-muted-foreground" />
                <Mono className="font-medium">#{match.order.id}</Mono>
                <span className="text-sm truncate">{match.order.shortName}</span>
                <Mono className="ml-auto text-sm">{money(match.order.price)}</Mono>
              </div>
              <p className="text-xs text-muted-foreground">
                Delivered {match.order.deliveredLabel}
                {match.order.deliveredDate && ` (${match.order.deliveredDate})`} · {match.order.inStock ? `In stock${match.order.stockUnits ? ` (${match.order.stockUnits})` : ""}` : "Out of stock"} · {match.order.payment}
              </p>
              {match.method !== "exact" && match.method !== "spoken" && <p className="text-xs">{match.note}</p>}
              <p className={cn("text-xs", match.needsConfirmation && !match.confirmed ? "text-amber-600" : "text-muted-foreground")}>
                {match.confirmed ? (match.confirmedBy === "panel" ? "Confirmed by the agent." : "Confirmed: the agent read the order number back.") : match.needsConfirmation ? "Confirm with the caller." : "Exact match in this customer's orders."}
              </p>
              {/* Eligibility checks, computed from the order data and SOP rules */}
              {checks.length > 0 && (
                <ul className="grid grid-cols-1 gap-1 border-t border-border pt-2 text-xs" aria-label="Checks from the order data and SOP rules">
                  {checks.map((c) => (
                    <li key={c.id} className="flex items-center gap-2" title={c.sopRef}>
                      {c.pass ? <CheckIcon weight="bold" className="size-3 text-cyan drop-shadow-[0_0_1px_rgb(16_37_66_/_0.6)]" /> : <XIcon weight="bold" className="size-3 text-destructive" />}
                      <span>{c.label}</span>
                      <span className="ml-auto text-muted-foreground">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {!verification.verified && <LockSimpleIcon className="size-3.5" />}
              {order.heard ? (
                <span>
                  Heard <Mono className="text-foreground">{order.heard.reading}</Mono>
                  {order.heard.method === "sound-alike" && <> (from &ldquo;{order.heard.text}&rdquo;)</>}
                  {verification.verified ? ". Not found in this customer's orders; ask for the number again." : ". Locked until the identity check."}
                </span>
              ) : verification.verified ? (
                "No order number yet."
              ) : (
                "Order details stay locked until the identity check."
              )}
            </p>
          )}
        </Section>

        {/* SOP steps */}
        <Section label={`SOP ${pack.sop.id}`} meta={
          <Button variant="ghost" size="xs" className="-mr-2 h-5 text-muted-blue" onClick={() => setSop(true)}>
            Open SOP <ArrowSquareOutIcon data-icon="inline-end" />
          </Button>
        }>
          <Steps steps={steps} />
        </Section>

        {/* Documentation, filled once the agent approves */}
        {rec?.approval.state === "approved" && (
          <Section label="Documentation">
            <dl className="space-y-1 text-xs">
              {view.documentation.map((d) => (
                <div key={d.label} className="grid grid-cols-[8rem_1fr] gap-2">
                  <dt className="text-muted-foreground">{d.label}</dt>
                  <dd>{d.value ?? "Pending"}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        {resolvedAlerts.length > 0 && (
          <div className="space-y-2">
            {resolvedAlerts.map((a) => (
              <AlertCard key={a.id} alert={a} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
