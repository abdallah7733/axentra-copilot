import type { Metadata } from "next";
import { PresentationPlayer } from "@/components/presentation/player";

export const metadata: Metadata = { title: "Product Experience, Axentra Agent Copilot" };

export default function PresentationPage() {
  return <PresentationPlayer />;
}
