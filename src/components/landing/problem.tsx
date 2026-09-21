export function Problem() {
  return (
    <section id="product" className="scroll-mt-16">
      <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
        <div className="max-w-[65ch]">
          <h2 className="text-3xl font-medium tracking-tight md:text-4xl">The agent is not the bottleneck. The tab switching is.</h2>
          <div className="mt-8 space-y-5 text-base leading-relaxed text-muted-foreground md:text-lg">
            <p>
              A customer calls about a double charge. The agent has to keep the conversation going while opening the CRM, finding the billing
              record, re-reading the refund policy, checking whether they are even allowed to approve it, and then writing everything up
              afterwards. Every one of those is a small pause, and the customer hears each one.
            </p>
            <p>
              Most automation tries to remove the agent from the call. Axentra keeps them in it. The copilot listens alongside them, does the
              lookups and the policy reading, prepares the action, and then stops. The agent decides. The record writes itself.
            </p>
            <p>
              This prototype walks through one real scenario, end to end, on a fictional telecom provider with simulated systems. Nothing
              here is a slide.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
