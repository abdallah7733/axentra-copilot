"use client";

import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { sop } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Mono } from "./bits";

export function SopBody({ highlight }: { highlight?: "A" | "B" }) {
  return (
    <div className="space-y-6 text-[13px] leading-relaxed">
      <section>
        <h3 className="mb-2 text-sm font-medium">{sop.verification.title}</h3>
        <ol className="list-decimal space-y-1 pl-5">
          {sop.verification.factors.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ol>
        <p className="mt-2 text-muted-foreground">{sop.verification.failure}</p>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Refund authority matrix</h3>
        <table className="w-full">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-normal">Amount</th>
              <th className="py-1 font-normal">Approver</th>
              <th className="py-1 font-normal">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sop.authority.map((a, i) => (
              <tr key={a.range} className={cn(i === 0 && highlight === "A" && "bg-cyan/10")}>
                <td className="py-1.5 pr-2"><Mono>{a.range}</Mono></td>
                <td className="py-1.5 pr-2">{a.approver}</td>
                <td className="py-1.5 text-muted-foreground">{a.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {sop.scenarios.map((s) => (
        <section key={s.id} className={cn("rounded-md border p-3", highlight === s.id ? "border-navy dark:border-white" : "border-border")}>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant={highlight === s.id ? "default" : "outline"} className={cn("font-mono text-[10px]", highlight === s.id && "bg-navy text-white dark:bg-white dark:text-navy")}>
              Scenario {s.id}
            </Badge>
            <h3 className="text-sm font-medium">{s.title}</h3>
            {highlight === s.id && <span className="ml-auto text-xs text-muted-foreground">Applies to this call</span>}
          </div>
          <div className="text-xs text-muted-foreground">Conditions</div>
          <ul className="mb-2 list-disc space-y-0.5 pl-5">
            {s.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="text-xs text-muted-foreground">Action</div>
          <p className="mb-2">{s.action}</p>
          <div className="text-xs text-muted-foreground">Authority</div>
          <p>{s.authority}</p>
        </section>
      ))}

      <section>
        <h3 className="mb-2 text-sm font-medium">Required documentation</h3>
        <ul className="list-disc space-y-0.5 pl-5">
          {sop.documentation.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function SopSheet() {
  const open = useDemo((s) => s.sopOpen);
  const setSop = useDemo((s) => s.setSop);
  const branch = useDemo((s) => s.branch);
  const highlight = branch === "unauthorized_transaction" ? "B" : "A";
  return (
    <Sheet open={open} onOpenChange={setSop}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{sop.title}</SheetTitle>
          <SheetDescription>
            <Mono>{sop.id}</Mono>. {sop.version}. Owner: {sop.owner}.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <SopBody highlight={highlight} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
