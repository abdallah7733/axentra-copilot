"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowSquareOutIcon, CheckCircleIcon, ShieldWarningIcon, WarningIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { atLeast, customer, duplicate, money, sop, transactions, type Step } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CaseSummary } from "./case-summary";
import { Explain, Mono, PanelHeader, ease } from "./bits";

type View = "standby" | "verification" | "transactions" | "analysis" | "refund" | "approved" | "summary" | "fraud";

function viewFor(step: Step, branch: string): View {
  if (branch === "unauthorized_transaction") return "fraud";
  if (branch === "verification_failed" || branch === "account_locked") return "verification";
  switch (step) {
    case "idle":
    case "incoming_call":
    case "intent_detected":
      return "standby";
    case "verification_started":
    case "email_verified":
    case "customer_verified":
      return "verification";
    case "account_retrieved":
    case "transactions_loaded":
    case "duplicate_detected":
      return "transactions";
    case "refund_recommended":
      return "analysis";
    case "refund_prepared":
    case "awaiting_human_approval":
      return "refund";
    case "refund_approved":
      return "approved";
    default:
      return "summary";
  }
}

const viewTitles: Record<View, string> = {
  standby: "Workspace",
  verification: "Identity verification",
  transactions: "Recent transactions",
  analysis: "Duplicate analysis",
  refund: "Refund preparation",
  approved: "Refund processed",
  summary: "Documentation",
  fraud: "Fraud and Risk handoff",
};

/* Transactions table with the duplicate pair highlighted once detected. */
function TransactionsView({ step, loading }: { step: Step; loading: boolean }) {
  const detected = atLeast(step, "duplicate_detected");
  const skeleton = loading || step === "account_retrieved";
  return (
    <div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1.5 font-normal">Transaction</th>
            <th className="py-1.5 font-normal">Date</th>
            <th className="py-1.5 font-normal">Description</th>
            <th className="py-1.5 font-normal text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {skeleton
            ? transactions.map((t) => (
                <tr key={t.id}>
                  <td className="py-2"><Skeleton className="h-3.5 w-16" /></td>
                  <td className="py-2"><Skeleton className="h-3.5 w-20" /></td>
                  <td className="py-2"><Skeleton className="h-3.5 w-40" /></td>
                  <td className="py-2"><Skeleton className="ml-auto h-3.5 w-12" /></td>
                </tr>
              ))
            : transactions.map((t, i) => {
                const isPair = detected && (t.id === duplicate.duplicateId || t.id === duplicate.original);
                return (
                  <motion.tr
                    key={t.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0, backgroundColor: isPair ? "color-mix(in oklch, var(--cyan) 12%, transparent)" : "rgba(0,0,0,0)" }}
                    transition={{ delay: i * 0.05, duration: 0.35, ease }}
                    className={cn(isPair && "font-medium")}
                  >
                    <td className="py-2 pr-2">
                      <Mono>{t.id}</Mono>
                      {detected && t.duplicateOf && (
                        <Badge className="ml-2 h-4 bg-navy px-1.5 text-[10px] text-white dark:bg-white dark:text-navy">Duplicate</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-2 whitespace-nowrap"><Mono className="text-muted-foreground">{t.date} {t.time}</Mono></td>
                    <td className="py-2 pr-2 text-muted-foreground">{t.description}</td>
                    <td className="py-2 text-right"><Mono>{money(t.amount)}</Mono></td>
                  </motion.tr>
                );
              })}
        </tbody>
      </table>
      {detected && !skeleton && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <WarningIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
          Two charges of {money(duplicate.amount)} to Visa {customer.cardLast4}, {duplicate.gapSeconds} seconds apart, same plan line. Meets all Scenario A conditions.
        </motion.p>
      )}
    </div>
  );
}

function AnalysisView({ onSop }: { onSop: () => void }) {
  const scenario = sop.scenarios[0];
  const pair = transactions.filter((t) => t.id === duplicate.original || t.id === duplicate.duplicateId).reverse();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {pair.map((t, i) => (
          <motion.div key={t.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1, duration: 0.35, ease }} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <Mono className="font-medium">{t.id}</Mono>
              <Badge variant={t.duplicateOf ? "default" : "outline"} className={cn("h-4 px-1.5 text-[10px]", t.duplicateOf && "bg-navy text-white dark:bg-white dark:text-navy")}>
                {t.duplicateOf ? "Refund" : "Keep"}
              </Badge>
            </div>
            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <div><Mono>{t.date} {t.time}</Mono></div>
              <div>{t.method}</div>
              <div>{t.description}</div>
            </div>
            <div className="mt-2 text-lg font-medium tracking-tight"><Mono>{money(t.amount)}</Mono></div>
          </motion.div>
        ))}
      </div>
      <div className="rounded-md border border-border bg-muted/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium">{sop.id}, Scenario {scenario.id}: {scenario.title}</span>
          <Button variant="ghost" size="xs" className="text-muted-blue" onClick={onSop}>
            View SOP <ArrowSquareOutIcon data-icon="inline-end" />
          </Button>
        </div>
        <ul className="space-y-1">
          {scenario.conditions.map((c, i) => (
            <motion.li key={c} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.12 }} className="flex items-start gap-2 text-[13px]">
              <CheckCircleIcon weight="fill" className="mt-0.5 size-3.5 shrink-0 text-navy dark:text-white" />
              <span>{c}</span>
            </motion.li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{scenario.action}</p>
      </div>
    </div>
  );
}

function RefundView() {
  const step = useDemo((s) => s.step);
  const openApproval = useDemo((s) => s.openApproval);
  const escalated = useDemo((s) => s.escalated);
  const ready = step === "awaiting_human_approval";
  const field = (label: string, value: string, mono = true) => (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <Input readOnly value={value} className={cn("h-8 bg-muted/40 text-[13px]", mono && "font-mono")} />
    </label>
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {field("Transaction", duplicate.duplicateId)}
        {field("Amount", money(duplicate.amount))}
        {field("Refund to", customer.paymentMethod, false)}
        {field("Reason code", "DUP-01 Duplicate charge", false)}
        {field("Reference", duplicate.refundReference)}
        {field("Authority band", `${sop.authority[0].range}, ${sop.authority[0].approver}`, false)}
      </div>
      <Explain label="Why these values">
        The copilot pre-fills every field from the analysis: the later charge, its exact amount, the card it was taken from, and the SOP reason code. It never submits. The agent reviews and decides.
      </Explain>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 p-3">
        <div className="text-[13px]">
          {escalated ? (
            <span className="flex items-center gap-1.5 text-muted-foreground"><WarningIcon className="size-3.5" /> Escalated to Team Lead. You can still approve if you change your mind.</span>
          ) : ready ? (
            <span>Customer has agreed. Ready for your decision.</span>
          ) : (
            <span className="text-muted-foreground">Confirm with the customer before approving.</span>
          )}
        </div>
        <Button
          onClick={() => openApproval(true)}
          disabled={!ready}
          className={cn("shrink-0 rounded-full", ready && "bg-cyan text-navy hover:bg-cyan/85 ring-2 ring-cyan/30 ring-offset-2 ring-offset-background")}
        >
          Review and approve
        </Button>
      </div>
    </div>
  );
}

function ApprovedView() {
  return (
    <div className="space-y-3">
      <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }} className="flex items-center gap-3">
        <CheckCircleIcon weight="fill" className="size-8 text-navy dark:text-white" />
        <div>
          <div className="text-base font-medium tracking-tight">Refund of {money(duplicate.amount)} processed</div>
          <div className="text-xs text-muted-foreground">
            <Mono>{duplicate.duplicateId}</Mono> to Visa {customer.cardLast4}, ref <Mono>{duplicate.refundReference}</Mono>. Settles in {duplicate.settlementDays}.
          </div>
        </div>
      </motion.div>
      <p className="text-[13px] text-muted-foreground">Confirmation email queued to {customer.emailMasked}. Case documentation is being written.</p>
    </div>
  );
}

function VerificationView({ step, branch }: { step: Step; branch: string }) {
  const email = useDemo((s) => s.email);
  const last4 = useDemo((s) => s.last4);
  const locked = branch === "account_locked";
  const prompts = [
    { key: "email", label: "Ask for the email address on file", state: email, script: "\"Can you confirm the email address on the account?\"" },
    { key: "last4", label: "Ask for the last four digits of the payment card", state: last4, script: "\"And the last four digits of the card used for payment?\"" },
  ];
  return (
    <div className="space-y-4">
      <ol className="space-y-2">
        {prompts.map((p, i) => (
          <motion.li key={p.key} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }} className={cn("rounded-md border p-3", p.state === "pending" ? "border-cyan/60" : "border-border", p.state === "idle" && "opacity-60")}>
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-medium">{i + 1}. {p.label}</span>
              <span className={cn("text-xs", p.state === "ok" ? "text-foreground" : p.state === "fail" ? "text-destructive" : "text-muted-foreground")}>
                {p.state === "ok" ? "Matched" : p.state === "fail" ? "Not matched" : p.state === "pending" ? "In progress" : "Next"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{p.script}</p>
          </motion.li>
        ))}
      </ol>
      {locked ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[13px]">
          <div className="flex items-center gap-2 font-medium"><ShieldWarningIcon className="size-4 text-destructive" /> Account locked for this session</div>
          <p className="mt-1 text-xs text-muted-foreground">{sop.verification.failure}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {step === "customer_verified" ? "Both factors matched. Account context is now unlocked." : "Account data stays hidden until both factors match. Never read details back to the caller."}
        </p>
      )}
    </div>
  );
}

function FraudView({ onSop }: { onSop: () => void }) {
  const scenario = sop.scenarios[1];
  const steps = ["Temporary hold placed on Visa 4471", "Fraud and Risk case opened, priority: same day", "Customer informed of callback window", "Refund path closed at agent level"];
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-md border border-border bg-muted/50 p-3">
        <ShieldWarningIcon className="mt-0.5 size-5 shrink-0" />
        <div className="text-[13px]">
          <div className="font-medium">{sop.id}, Scenario {scenario.id}: {scenario.title}</div>
          <p className="mt-1 text-xs text-muted-foreground">{scenario.action}</p>
        </div>
        <Button variant="ghost" size="xs" className="ml-auto shrink-0 text-muted-blue" onClick={onSop}>
          View SOP <ArrowSquareOutIcon data-icon="inline-end" />
        </Button>
      </div>
      <ol className="space-y-1.5">
        {steps.map((s, i) => (
          <motion.li key={s} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.12 }} className="flex items-center gap-2 text-[13px]">
            <CheckCircleIcon weight="fill" className="size-3.5 text-navy dark:text-white" /> {s}
          </motion.li>
        ))}
      </ol>
      <Explain label="Why the copilot cannot approve here">{scenario.authority}</Explain>
    </div>
  );
}

export function ContextualWorkspace({ className }: { className?: string }) {
  const step = useDemo((s) => s.step);
  const branch = useDemo((s) => s.branch);
  const loading = useDemo((s) => s.loading);
  const setSop = useDemo((s) => s.setSop);
  const view = viewFor(step, branch);

  return (
    <Card className={cn("rounded-lg py-0 gap-0 ring-0 border border-border shadow-none min-h-0 flex flex-col", className)}>
      <PanelHeader title={viewTitles[view]} meta={view === "standby" ? undefined : `Case ${"CS-2026-091403"}`} />
      <div className="relative flex-1 min-h-0 overflow-y-auto p-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3, ease }}
          >
            {view === "standby" && (
              <div className="flex h-full min-h-40 flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <p className="max-w-[32ch]">{step === "intent_detected" ? "Intent captured. Verification will start as soon as the agent asks the first factor." : "This panel changes with the call: verification, transactions, analysis, refund, documentation."}</p>
              </div>
            )}
            {view === "verification" && <VerificationView step={step} branch={branch} />}
            {view === "transactions" && <TransactionsView step={step} loading={loading} />}
            {view === "analysis" && <AnalysisView onSop={() => setSop(true)} />}
            {view === "refund" && <RefundView />}
            {view === "approved" && <ApprovedView />}
            {view === "summary" && <CaseSummary />}
            {view === "fraud" && <FraudView onSop={() => setSop(true)} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </Card>
  );
}
