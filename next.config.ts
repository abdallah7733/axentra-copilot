import type { NextConfig } from "next";

/*
  STATIC_EXPORT=1 builds a plain folder of HTML/JS/CSS in ./out that any static
  host can serve. NEXT_PUBLIC_BASE_PATH is for hosts that serve the site from a
  subdirectory, such as a GitHub Pages project site ("/axentra-copilot").
*/
const isExport = process.env.STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Keeps the dev-mode indicator out of screen recordings made against `next dev`.
  devIndicators: false,
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
