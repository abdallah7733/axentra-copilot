"use client";

import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { sop as atlasOneSop, type Sop } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Mono } from "./bits";

/**
 * Any client's SOP. `highlight` marks the scenario that applies to this call and
 * `authorityRow` the authority band it falls in.
 */
export function SopBody({ sop, highlight, authorityRow }: { sop: Sop; highlight?: string; authorityRow?: number }) {
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

      {sop.rules && (
        <section>
          <h3 className="mb-2 text-sm font-medium">{sop.rules.title}</h3>
          <ul className="list-disc space-y-1 pl-5">
            {sop.rules.items.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-sm font-medium">{sop.authorityTitle}</h3>
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
              <tr key={a.range} className={cn(i === authorityRow && "bg-cyan/10")}>
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

export function SopSheet({
  sop,
  open,
  onOpenChange,
  highlight,
  authorityRow,
  note,
}: {
  sop: Sop;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlight?: string;
  authorityRow?: number;
  /** Extra line under the SOP reference, for example that the client is fictional. */
  note?: string;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{sop.title}</SheetTitle>
          <SheetDescription>
            <Mono>{sop.id}</Mono>. {sop.version}. Owner: {sop.owner}.{note && <> {note}</>}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <SopBody sop={sop} highlight={highlight} authorityRow={authorityRow} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The scripted demo's SOP sheet: AtlasOne's BIL-SOP-4.2, driven by the demo store. */
export function DemoSopSheet() {
  const open = useDemo((s) => s.sopOpen);
  const setSop = useDemo((s) => s.setSop);
  const branch = useDemo((s) => s.branch);
  const highlight = branch === "unauthorized_transaction" ? "B" : "A";
  return <SopSheet sop={atlasOneSop} open={open} onOpenChange={setSop} highlight={highlight} authorityRow={highlight === "A" ? 0 : undefined} />;
}
