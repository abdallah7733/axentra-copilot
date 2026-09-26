import type { Metadata } from "next";
import { LiveConsole } from "@/components/live/live-console";

export const metadata: Metadata = { title: "Live Call, Axentra Agent Copilot" };

export default function LivePage() {
  return <LiveConsole />;
}
