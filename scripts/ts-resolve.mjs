// Lets `node --test` run the plain-TypeScript modules in src/lib as the app imports them:
// "@/..." resolves to src/, and extensionless relative imports resolve to .ts files.
// Node 24 strips the types itself; this only fills in the paths Next.js resolves for us.
//   node --import ./scripts/ts-resolve.mjs --test 'src/**/*.test.ts'
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath, pathToFileURL } from "node:url";
      const src = new URL("../src/", ${JSON.stringify(import.meta.url)});
      export async function resolve(specifier, context, next) {
        let target = specifier;
        if (specifier.startsWith("@/")) target = new URL(specifier.slice(2), src).href;
        else if (/^\\.\\.?\\//.test(specifier) && context.parentURL) target = new URL(specifier, context.parentURL).href;
        else return next(specifier, context);
        if (!/\\.[cm]?[jt]sx?$/.test(target) && existsSync(fileURLToPath(target + ".ts"))) target += ".ts";
        return next(target, context);
      }
    `)
);
