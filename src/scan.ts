import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { profileToHash, type Issue } from "../../../src/lib/engine";
import {
  boundsOf,
  HELP,
  localOffsetMinutes,
  parseArgs,
  periodRange,
  verdictUrl,
  type ScanArgs,
} from "./args";
import { assembleProfile, type Assembled } from "./assemble";
import { loadCcusage, systemTimeZone, type CcusageLoad } from "./ccusage-run";
import { claudeConfigDirs, readClaudeLogs } from "./claude-jsonl";
import { codexHomeDir, readCodexLogs } from "./codex-rollout";
import { noteLines, renderPreview } from "./preview";
import { localDay, toReports } from "./reports";

const CCUSAGE_READER =
  "npx ccusage@latest claude daily|session y blocks --json --offline --breakdown";

const PROMPT = "¿Abrir el veredicto en el navegador? [s/N] ";

export type ScanIo = {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  timeZone: string | null;
  isTTY: boolean;
  loadCcusage: (input: {
    since: string;
    until: string;
    timeZone: string | null;
  }) => Promise<CcusageLoad>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompt: (question: string) => Promise<string>;
  open: (url: string) => Promise<void>;
};

function accepted(answer: string): boolean {
  return /^(s|si|sí|y|yes)$/i.test(answer.trim());
}

function renderFailure(period: string, issues: Issue[], warnings: string[]): string {
  const lines = [`No hay un perfil válido para ${period}.`];
  if (issues.length) {
    lines.push("El perfil no cumple pickagent.profile/v1:");
    for (const issue of issues) {
      lines.push(`- ${issue.path || "(raíz)"}: ${issue.message}`);
    }
  }
  const notes = noteLines(warnings);
  if (notes.length) {
    lines.push("Notas:");
    for (const note of notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

async function fromClaude(args: ScanArgs, io: ScanIo, offset: number): Promise<Assembled & { reader: string }> {
  const range = periodRange(args.period);
  const bounds = boundsOf(args.period, offset);
  if (!range || !bounds) {
    return {
      profile: null,
      issues: [{ path: "period", message: "periodo inválido" }],
      warnings: [],
      reader: "",
    };
  }
  const loaded = await io.loadCcusage({
    since: range.since,
    until: range.until,
    timeZone: io.timeZone,
  });
  const base = {
    period: args.period,
    plans: args.plans,
    source: "claude-code" as const,
    utcOffsetMinutes: offset,
  };
  if (!loaded.failed) {
    const fromTool = assembleProfile({
      ...base,
      reports: loaded.reports,
      hits: [],
    });
    if (fromTool.profile) return { ...fromTool, reader: CCUSAGE_READER };
  }
  const logs = await readClaudeLogs(claudeConfigDirs(io.env, io.home), bounds, offset);
  const local = assembleProfile({
    ...base,
    reports: toReports(logs),
    hits: logs.hits,
    limitHitsKnown: true,
    extraWarnings: [loaded.failed ? "ccusage_failed" : "ccusage_incomplete"],
  });
  const reader = io.env.CLAUDE_CONFIG_DIR
    ? "parser local (CLAUDE_CONFIG_DIR)"
    : "parser local de ~/.claude/projects/**/*.jsonl";
  return { ...local, reader };
}

async function fromCodex(args: ScanArgs, io: ScanIo, offset: number): Promise<Assembled & { reader: string }> {
  const bounds = boundsOf(args.period, offset);
  if (!bounds) {
    return {
      profile: null,
      issues: [{ path: "period", message: "periodo inválido" }],
      warnings: [],
      reader: "",
    };
  }
  const logs = await readCodexLogs(codexHomeDir(io.env, io.home), bounds, offset);
  const assembled = assembleProfile({
    reports: toReports(logs),
    hits: logs.hits,
    period: args.period,
    plans: args.plans,
    source: "codex",
    utcOffsetMinutes: offset,
    estimateTokens: true,
    limitHitsKnown: true,
    extraWarnings: ["codex_experimental", "codex_cache_write_unreported"],
  });
  return {
    ...assembled,
    reader: "parser experimental de $CODEX_HOME/sessions/**/rollout-*.jsonl",
  };
}

async function maybeOpen(args: ScanArgs, io: ScanIo, url: string) {
  if (args.noOpen) return;
  const openNow =
    args.yes || (args.json ? false : io.isTTY && accepted(await io.prompt(PROMPT)));
  if (!openNow) {
    if (!args.json && !io.isTTY && !args.yes) {
      io.stderr("No hay terminal interactiva. El veredicto no se abre.\n");
    }
    return;
  }
  try {
    await io.open(url);
  } catch {
    io.stderr("No se pudo abrir el navegador. La URL está en el perfil.\n");
  }
}

export async function runScan(argv: string[], io: ScanIo): Promise<number> {
  const offset = localOffsetMinutes(io.now);
  const parsed = parseArgs(argv, io.now, offset);
  if (!parsed.ok) {
    io.stderr(`pickagent: ${parsed.error}\n`);
    return 1;
  }
  if (parsed.help) {
    io.stdout(`${HELP}\n`);
    return 0;
  }
  const args = parsed.args;
  const assembled = args.codex
    ? await fromCodex(args, io, offset)
    : await fromClaude(args, io, offset);
  if (!assembled.profile) {
    io.stderr(renderFailure(args.period, assembled.issues, assembled.warnings));
    return 1;
  }
  const url = verdictUrl(args.baseUrl, profileToHash(assembled.profile));
  if (args.json) {
    io.stdout(`${JSON.stringify(assembled.profile, null, 2)}\n`);
    if (args.codex || assembled.warnings.some((warning) => warning.startsWith("ccusage_"))) {
      for (const line of noteLines(assembled.warnings)) io.stderr(`${line}\n`);
    }
  } else {
    io.stdout(
      `${renderPreview(assembled.profile, {
        url,
        warnings: assembled.warnings,
        scannedAt: localDay(io.now.getTime(), offset),
        reader: assembled.reader,
      })}\n`,
    );
  }
  await maybeOpen(args, io, url);
  return 0;
}

export function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function realIo(): ScanIo {
  return {
    env: process.env,
    home: homedir(),
    now: new Date(),
    timeZone: systemTimeZone(),
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    loadCcusage: (input) =>
      loadCcusage({ ...input, env: process.env }),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    open: openUrl,
  };
}
