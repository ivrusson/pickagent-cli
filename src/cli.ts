import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realIo, runScan } from "./scan";

export async function main(argv: string[]): Promise<number> {
  try {
    return await runScan(argv, realIo());
  } catch {
    process.stderr.write(
      "pickagent: error inesperado. No se abre el navegador.\n",
    );
    return 1;
  }
}

/**
 * True when this file is the process entry. `npx` and `npm install -g`
 * invoke a symlink named `pickagent`, so the check follows that link.
 * Importing the module from tests does not match.
 *
 * The comparison is the file itself: `import.meta.url` against
 * `pathToFileURL(realpathSync(argv[1]))`, and the same check after
 * realpath on this module so a symlinked checkout still matches.
 */
export function isDirectCli(argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    const entry = pathToFileURL(realpathSync(argv1)).href;
    if (import.meta.url === entry) return true;
    const self = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return entry === self;
  } catch {
    return false;
  }
}

if (isDirectCli(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
