"use client";

import { AnimatePresence, motion } from "motion/react";
import { CheckIcon, LockSimpleIcon, LockSimpleOpenIcon, XIcon } from "@phosphor-icons/react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { atLeast, customer, sop } from "@/lib/demo-data";
import { useDemo, type Factor } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Explain, Mono, PanelHeader } from "./bits";

function FactorRow({ label, state, hint }: { label: string; state: Factor; hint: string }) {
  return (
    <li className="flex items-center gap-2.5 text-[13px]">
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          state === "ok" && "bg-navy border-navy text-white dark:bg-white dark:border-white dark:text-navy",
          state === "fail" && "border-destructive text-destructive",
          state === "pending" && "border-cyan bg-cyan/15",
          state === "idle" && "border-border"
        )}
      >
        {state === "ok" && <CheckIcon weight="bold" className="size-2.5" />}
        {state === "fail" && <XIcon weight="bold" className="size-2.5" />}
      </span>
      <span className={cn(state === "idle" && "text-muted-foreground")}>{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">
        {state === "ok" ? "Confirmed" : state === "fail" ? "Not matched" : state === "pending" ? "Asking" : hint}
      </span>
    </li>
  );
}

const fields: { label: string; value: string; mono?: boolean }[] = [
  { label: "Account", value: customer.accountId, mono: true },
  { label: "Plan", value: `${customer.plan}, $${customer.planPrice}/mo` },
  { label: "Billing", value: customer.billingCycle },
  { label: "Payment", value: customer.paymentMethod },
  { label: "Customer since", value: customer.customerSince },
  { label: "Status", value: customer.status },
];

export function CustomerContext({ className, compact = false }: { className?: string; compact?: boolean }) {
  const step = useDemo((s) => s.step);
  const branch = useDemo((s) => s.branch);
  const email = useDemo((s) => s.email);
  const last4 = useDemo((s) => s.last4);
  const attempts = useDemo((s) => s.attempts);
  const loading = useDemo((s) => s.loading);

  const locked = branch === "account_locked";
  const unlocked = atLeast(step, "customer_verified") && branch !== "verification_failed" && !locked;
  const fetching = step === "account_retrieved" && loading;

  return (
    <Card className={cn("rounded-lg py-0 gap-0 ring-0 border border-border shadow-none min-h-0 flex flex-col overflow-hidden", className)}>
      <PanelHeader title="Customer context" meta={locked ? "Locked" : unlocked ? customer.name : "Verification required"}>
        <motion.span
          key={unlocked ? "open" : "closed"}
          initial={{ scale: 0.6, rotate: unlocked ? -20 : 0, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 18 }}
          className={cn("text-muted-foreground", locked && "text-destructive", unlocked && "text-foreground")}
        >
          {unlocked ? <LockSimpleOpenIcon className="size-4" /> : <LockSimpleIcon className="size-4" weight={locked ? "fill" : "regular"} />}
        </motion.span>
      </PanelHeader>

      <div className="relative flex-1 min-h-0 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          {!unlocked ? (
            <motion.div
              key="locked"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, filter: "blur(6px)", scale: 0.985 }}
              transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
              className="p-4 space-y-4"
            >
              {/* Dimmed placeholder of the real shape, so the reveal reads as an unlock */}
              <div className="space-y-2.5 select-none" aria-hidden>
                {fields.slice(0, compact ? 3 : 5).map((f) => (
                  <div key={f.label} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-muted-foreground/60">{f.label}</span>
                    <span className="h-3 w-24 rounded-sm bg-foreground/8 blur-[3px]" />
                  </div>
                ))}
              </div>

              <div className={cn("rounded-md border p-3", locked ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/50")}>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium">
                  {locked ? <LockSimpleIcon weight="fill" className="size-3.5 text-destructive" /> : <LockSimpleIcon className="size-3.5" />}
                  {locked ? "Locked for this session" : "Two-factor verification"}
                </div>
                {locked ? (
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    <p>Two failed attempts. Account data stays hidden. Warm transfer to the Identity team.</p>
                    {!compact && (
                      <Explain label="Why lock instead of retry" className="mt-2">
                        {sop.verification.failure}
                      </Explain>
                    )}
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    <FactorRow label="Email on file" state={email} hint="Ask" />
                    <FactorRow label="Card last four" state={last4} hint="Ask" />
                  </ul>
                )}
                {branch === "verification_failed" && (
                  <p className="mt-2 text-xs text-muted-foreground">Attempt {attempts} of 2 failed. Re-ask both factors. Do not say which one missed.</p>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="unlocked"
              initial={{ opacity: 0, filter: "blur(8px)", y: 6 }}
              animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 26, mass: 0.9 }}
              className="p-4"
            >
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <div>
                  <div className="text-base font-medium tracking-tight">{customer.name}</div>
                  <div className="text-xs text-muted-foreground">{customer.address}</div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div>{customer.emailMasked}</div>
                  <Mono>{customer.phoneMasked}</Mono>
                </div>
              </div>
              <dl className="divide-y divide-border">
                {fields.map((f, i) => (
                  <motion.div
                    key={f.label}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.08 + i * 0.05, duration: 0.3 }}
                    className="flex items-center justify-between gap-3 py-1.5 text-[13px]"
                  >
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className={cn("text-right", f.mono && "font-mono")}>
                      {fetching ? <Skeleton className="h-3.5 w-28" /> : f.value}
                    </dd>
                  </motion.div>
                ))}
              </dl>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}
