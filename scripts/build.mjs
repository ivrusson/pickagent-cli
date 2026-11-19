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

function zodLicense() {
  const licensePath = join(packageRoot, "node_modules", "zod", "LICENSE");
  if (!existsSync(licensePath)) {
    return "zod (https://github.com/colinhacks/zod) is bundled under the MIT License.";
  }
  return readFileSync(licensePath, "utf8").trim().replace(/\*\//g, "* /");
}

const thirdParty = `/*!
 * Third-party notices
 * This bundle includes zod. Its license follows.
 *
${zodLicense()
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
