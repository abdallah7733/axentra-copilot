"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { company, customer, duplicate, money, sop } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { Mono } from "./bits";

/*
  The single most important click in the demo. This Approve button is the one
  deliberate large cyan surface in the whole product.
*/
export function ApprovalDialog() {
  const open = useDemo((s) => s.approvalOpen);
  const setOpen = useDemo((s) => s.openApproval);
  const approve = useDemo((s) => s.approve);
  const escalate = useDemo((s) => s.escalate);

  const rows: [string, React.ReactNode][] = [
    ["Refund", <Mono key="a" className="font-medium">{money(duplicate.amount)}</Mono>],
    ["Transaction", <Mono key="t">{duplicate.duplicateId}</Mono>],
    ["To", `${customer.paymentMethod} (original method)`],
    ["Customer", `${customer.name}, ${customer.accountId}`],
    ["Policy", `${sop.id} Scenario A`],
    ["Your authority", `${sop.authority[0].range}, ${sop.authority[0].approver}`],
    ["Approver", `${company.agent.name} (${company.agent.id})`],
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approve refund</DialogTitle>
          <DialogDescription>Nothing is sent until you approve. This action is logged under your agent ID.</DialogDescription>
        </DialogHeader>
        <dl className="divide-y divide-border rounded-md border border-border text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[7rem_1fr] gap-3 px-3 py-2">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" className="rounded-full" onClick={escalate}>
              Escalate to Team Lead
            </Button>
            <Button className="rounded-full bg-cyan px-5 text-navy hover:bg-cyan/85" onClick={approve} autoFocus>
              Approve {money(duplicate.amount)} refund
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
