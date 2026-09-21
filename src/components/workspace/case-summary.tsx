"use client";

import { motion } from "motion/react";
import { Skeleton } from "@/components/ui/skeleton";
import { company, customer, duplicate, intent, money, sop } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { Mono } from "./bits";

function fmt(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function CaseSummary() {
  const loading = useDemo((s) => s.loading);
  const approvedAt = useDemo((s) => s.approvedAt);
  const step = useDemo((s) => s.step);

  const rows: [string, React.ReactNode][] = [
    ["Case", <Mono key="c">{company.caseId}</Mono>],
    ["Customer", <>{customer.name}, <Mono>{customer.accountId}</Mono></>],
    ["Intent", `${intent.label} (${intent.confidence}% confidence)`],
    ["Verification", "Two-factor: email on file and card last four, both confirmed"],
    ["Finding", <><Mono>{duplicate.duplicateId}</Mono> duplicates <Mono>{duplicate.original}</Mono>, {money(duplicate.amount)} each, {duplicate.gapSeconds}s apart</>],
    ["Action", <>Refund {money(duplicate.amount)} to Visa {customer.cardLast4}, ref <Mono>{duplicate.refundReference}</Mono></>],
    ["Policy", `${sop.id} Scenario A, ${sop.authority[0].range} band`],
    ["Approved by", <>{company.agent.name} (<Mono>{company.agent.id}</Mono>), <Mono>{fmt(approvedAt)}</Mono></>],
    ["Customer informed", `Verbal on call, email confirmation queued. Settlement ${duplicate.settlementDays}.`],
    ["Status", step === "resolved" ? "Resolved, call ended" : "Resolved, wrapping up"],
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Case summary</h3>
        <span className="text-[11px] text-muted-foreground">Generated automatically by Axentra</span>
      </div>
      {loading ? (
        <div className="space-y-2.5">
          {rows.map(([k]) => (
            <div key={k} className="grid grid-cols-[7.5rem_1fr] gap-3">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-[80%]" />
            </div>
          ))}
        </div>
      ) : (
        <dl className="divide-y divide-border rounded-md border border-border">
          {rows.map(([k, v], i) => (
            <motion.div
              key={k}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.3 }}
              className="grid grid-cols-[7.5rem_1fr] gap-3 px-3 py-2 text-[13px]"
            >
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="leading-snug">{v}</dd>
            </motion.div>
          ))}
        </dl>
      )}
    </div>
  );
}
