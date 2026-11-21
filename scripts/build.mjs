import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  console.error("esbuild is not installed. Run npm ci, then retry.");
  process.exit(1);
}

const outfile = join(packageRoot, "dist", "cli.js");
await mkdir(dirname(outfile), { recursive: true });

function licenseText(pkg, fallback) {
  const licensePath = join(packageRoot, "node_modules", pkg, "LICENSE");
  if (!existsSync(licensePath)) return fallback;
  return readFileSync(licensePath, "utf8").trim().replace(/\*\//g, "* /");
}

const thirdParty = `/*!
 * Third-party notices
 * This bundle includes zod and @clack/prompts (@clack/core). Their licenses follow.
 *
 * --- zod ---
${licenseText("zod", "zod (https://github.com/colinhacks/zod) is bundled under the MIT License.")
  .split("\n")
  .map((line) => ` * ${line}`)
  .join("\n")}
 *
 * --- @clack/prompts ---
${licenseText(
  "@clack/prompts",
  "@clack/prompts (https://github.com/bombshell-dev/clack) is bundled under the MIT License.",
)
  .split("\n")
  .map((line) => ` * ${line}`)
  .join("\n")}
 */`;

await esbuild.build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "eof",
  footer: { js: thirdParty },
  logLevel: "info",
});

await chmod(outfile, 0o755);
