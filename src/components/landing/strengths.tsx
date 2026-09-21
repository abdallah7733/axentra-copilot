import { ArrowSquareOutIcon, CheckCircleIcon, LockSimpleIcon } from "@phosphor-icons/react/dist/ssr";
import { Mono } from "@/components/workspace/bits";
import { customer, duplicate, money, sop } from "@/lib/demo-data";
import { cn } from "@/lib/utils";

function Cell({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex flex-col rounded-lg border border-border bg-card p-6", className)}>{children}</div>;
}

function Title({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("text-lg font-medium tracking-tight", className)}>{children}</h3>;
}

/* Six strengths in a fixed 3x2 bento. Two cells carry real visual weight:
   the approval cell (navy, with the real three-button decision) and the
   verification cell (the lock). */
export function Strengths() {
  return (
    <section>
      <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
        <h2 className="max-w-[65ch] text-3xl font-medium tracking-tight md:text-4xl">Built to be trusted on a live call.</h2>
        <div className="mt-12 grid gap-4 md:grid-cols-3 md:grid-rows-2">
          {/* 1. Human in the loop */}
          <Cell className="bg-navy text-white border-navy">
            <Title className="text-white">A human approves every action</Title>
            <p className="mt-2 text-sm leading-relaxed text-white/70">The copilot prepares the refund and then stops. Nothing leaves the workspace without an agent clicking one of these.</p>
            <div className="mt-auto pt-8">
              <div className="rounded-md border border-white/15 bg-white/5 p-3 text-[13px]">
                <div className="flex items-center justify-between text-white/70">
                  <span>Refund</span>
                  <Mono className="text-white">{money(duplicate.amount)}</Mono>
                </div>
                <div className="mt-1 flex items-center justify-between text-white/70">
                  <span>Transaction</span>
                  <Mono className="text-white">{duplicate.duplicateId}</Mono>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded-full px-3 py-1.5 text-xs text-white/70">Cancel</span>
                  <span className="rounded-full border border-white/25 px-3 py-1.5 text-xs">Escalate</span>
                  <span className="rounded-full bg-cyan px-3 py-1.5 text-xs font-medium text-navy">Approve</span>
                </div>
              </div>
            </div>
          </Cell>

          {/* 2. SOP grounded */}
          <Cell>
            <Title>Recommendations cite the SOP</Title>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Each suggestion names the policy scenario it follows and the authority band it sits in, so the agent can check it in one click.</p>
            <ul className="mt-5 space-y-1.5 text-[13px]">
              {sop.scenarios[0].conditions.slice(0, 3).map((c) => (
                <li key={c} className="flex items-start gap-2">
                  <CheckCircleIcon weight="fill" className="mt-0.5 size-3.5 shrink-0" /> {c}
                </li>
              ))}
            </ul>
          </Cell>

          {/* 3. Verification gated */}
          <Cell>
            <div className="flex items-start justify-between gap-3">
              <Title>Nothing unlocks before verification</Title>
              <LockSimpleIcon className="size-5 shrink-0 text-muted-blue" />
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Customer data stays blurred until both identity factors match. Two failures lock the view for the session.</p>
            <div className="mt-5 space-y-2 text-[13px]" aria-hidden>
              {["Account", "Plan", "Payment"].map((l) => (
                <div key={l} className="flex items-center justify-between">
                  <span className="text-muted-foreground">{l}</span>
                  <span className="h-3 w-24 rounded-sm bg-foreground/10 blur-[3px]" />
                </div>
              ))}
            </div>
          </Cell>

          {/* 4. Explains itself */}
          <Cell>
            <Title>Every suggestion explains itself</Title>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Intent confidence, the evidence behind it, and the reasoning behind each recommendation are one click away, inline, without leaving the call.</p>
            <p className="mt-5 text-[13px]">
              <span className="text-muted-blue">Why this intent</span>
              <span className="text-muted-foreground"> · &quot;charged twice&quot; in the first customer turn · two same-amount charges within 24 hours</span>
            </p>
          </Cell>

          {/* 5. One workspace */}
          <Cell>
            <Title>One workspace, no tab hopping</Title>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Transcript, copilot, customer context, and the working panel sit side by side. The fourth panel changes with the call instead of the agent changing windows.</p>
            <div className="mt-5 grid grid-cols-[1fr_1.2fr_0.9fr] gap-1.5" aria-hidden>
              {["Live call", "Copilot", "Context"].map((l) => (
                <div key={l} className="rounded-sm border border-border bg-background px-2 py-3 text-[11px] text-muted-foreground">{l}</div>
              ))}
            </div>
          </Cell>

          {/* 6. Documentation */}
          <Cell>
            <Title>The case writes itself</Title>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">A complete summary with IDs, policy reference, approver, and customer communication is ready before the call ends.</p>
            <dl className="mt-5 space-y-1 text-[13px]">
              <div className="flex justify-between"><dt className="text-muted-foreground">Customer</dt><dd><Mono>{customer.accountId}</Mono></dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Action</dt><dd>Refund <Mono>{money(duplicate.amount)}</Mono></dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Policy</dt><dd><Mono>{sop.id}</Mono> Scenario A</dd></div>
            </dl>
          </Cell>
        </div>
        <p className="mt-6 flex items-center gap-1.5 text-sm text-muted-foreground">
          Read the full policy the demo runs on <a href="/sop" className="inline-flex items-center gap-1 text-muted-blue hover:text-foreground">Billing SOP 4.2 <ArrowSquareOutIcon className="size-3.5" /></a>
        </p>
      </div>
    </section>
  );
}
