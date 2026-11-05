import { realIo, runScan } from "./scan";

export async function main(argv: string[]): Promise<number> {
  try {
    return await runScan(argv, realIo());
  } catch {
    process.stderr.write("pickagent: error inesperado. No se abre el navegador.\n");
    return 1;
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("/cli.ts") || entry.endsWith("/cli.js") || entry.endsWith("\\cli.js")) {
  process.exitCode = await main(process.argv.slice(2));
}
