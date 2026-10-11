import { execSync } from "node:child_process";
import type { NextConfig } from "next";

/*
  STATIC_EXPORT=1 builds a plain folder of HTML/JS/CSS in ./out that any static
  host can serve. NEXT_PUBLIC_BASE_PATH is for hosts that serve the site from a
  subdirectory, such as a GitHub Pages project site ("/axentra-copilot").
*/
const isExport = process.env.STATIC_EXPORT === "1";

/** The commit a build came from, shown in the live console so a recorded call can be tied to its code. */
function buildCommit(): string | undefined {
  try {
    const commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return dirty ? `${commit} + local changes` : commit;
  } catch {
    return undefined;
  }
}

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Keeps the dev-mode indicator out of screen recordings made against `next dev`.
  devIndicators: false,
  env: { NEXT_PUBLIC_BUILD_COMMIT: buildCommit() ?? "" },
  ...(isExport
    ? {
        output: "export" as const,
        trailingSlash: true,
        images: { unoptimized: true },
        ...(basePath ? { basePath, assetPrefix: basePath } : {}),
      }
    : {}),
};

export default nextConfig;
