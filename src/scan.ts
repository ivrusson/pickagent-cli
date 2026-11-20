import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  mergeProfileParts,
  parseProfile,
  profileFromMultiAgent,
  profileToHash,
  type Issue,
  type Profile,
  type Source,
} from "./profile";
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
import {
  applyDetectedPlans,
  detectPlans,
} from "./detect-plans";
import { withDeclaredPlans } from "./plan-interview";
import { readCursorUsage } from "./cursor-usage";
import { noteLines, renderPreview } from "./preview";
import { localDay, toReports } from "./reports";

const CCUSAGE_READER =
  "npx ccusage@latest daily|session --json --by-agent y blocks --offline --breakdown";

const PROMPT = "Open the verdict in the browser? [y/N] ";

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
  // y/yes match the English prompt. s/si and s + i-acute still count as yes.
  return /^(s(?:i|\u00ed)?|y|yes)$/i.test(answer.trim());
}

function renderFailure(period: string, issues: Issue[], warnings: string[]): string {
  const lines = [`No valid profile for ${period}.`];
  if (issues.length) {
    lines.push("The profile does not match pickagent.profile/v1:");
    for (const issue of issues) {
      lines.push(`- ${issue.path || "(root)"}: ${issue.message}`);
    }
  }
  const notes = noteLines(warnings);
  if (notes.length) {
    lines.push("Notes:");
    for (const note of notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

function asAssembled(
  profile: Profile | null,
  warnings: string[],
  reader: string,
  issues: Issue[] = [],
): Assembled & { reader: string } {
  return { profile, issues, warnings, reader };
}

async function fromCodexOnly(
  args: ScanArgs,
  io: ScanIo,
  offset: number,
): Promise<Assembled & { reader: string }> {
  const bounds = boundsOf(args.period, offset);
  if (!bounds) {
    return asAssembled(null, [], "", [
      { path: "period", message: "invalid period" },
    ]);
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
    reader: "experimental parser for $CODEX_HOME/sessions/**/rollout-*.jsonl",
  };
}

async function fromLocalClaude(
  args: ScanArgs,
  io: ScanIo,
  offset: number,
  extraWarnings: string[],
): Promise<Assembled & { reader: string }> {
  const bounds = boundsOf(args.period, offset);
  if (!bounds) {
    return asAssembled(null, extraWarnings, "", [
      { path: "period", message: "invalid period" },
    ]);
  }
  const logs = await readClaudeLogs(claudeConfigDirs(io.env, io.home), bounds, offset);
  const local = assembleProfile({
    period: args.period,
    plans: args.plans,
    source: "claude-code",
    utcOffsetMinutes: offset,
    reports: toReports(logs),
    hits: logs.hits,
    limitHitsKnown: true,
    extraWarnings,
  });
  const reader = io.env.CLAUDE_CONFIG_DIR
    ? "local parser (CLAUDE_CONFIG_DIR)"
    : "local parser for ~/.claude/projects/**/*.jsonl";
  return { ...local, reader };
}

async function maybeMergeLocalCodex(
  profile: Profile,
  args: ScanArgs,
  io: ScanIo,
  offset: number,
  warnings: string[],
): Promise<{ profile: Profile; warnings: string[] }> {
  if (profile.by_source?.codex || profile.provenance.codex) {
    return { profile, warnings };
  }
  const bounds = boundsOf(args.period, offset);
  if (!bounds) return { profile, warnings };
  const logs = await readCodexLogs(codexHomeDir(io.env, io.home), bounds, offset);
  if (logs.sessions.size === 0 && logs.hits.length === 0) {
    return { profile, warnings };
  }
  const local = assembleProfile({
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
  if (!local.profile) {
    return { profile, warnings: [...warnings, ...local.warnings] };
  }
  const merged = mergeProfileParts([profile, local.profile], args.plans);
  if (!merged) return { profile, warnings: [...warnings, ...local.warnings] };
  return {
    profile: merged,
    warnings: [...warnings, ...local.warnings],
  };
}

async function maybeMergeLocalCursor(
  profile: Profile,
  args: ScanArgs,
  io: ScanIo,
  offset: number,
  warnings: string[],
): Promise<{ profile: Profile; warnings: string[] }> {
  if (profile.by_source?.cursor || profile.provenance.cursor) {
    return { profile, warnings };
  }
  const bounds = boundsOf(args.period, offset);
  if (!bounds) return { profile, warnings };
  const logs = await readCursorUsage(io.env, io.home, bounds, offset);
  if (logs.sessions.size === 0) {
    return { profile, warnings };
  }
  const local = assembleProfile({
    reports: toReports(logs),
    hits: logs.hits,
    period: args.period,
    plans: args.plans,
    source: "cursor",
    utcOffsetMinutes: offset,
    estimateTokens: true,
    limitHitsKnown: true,
    extraWarnings: [
      "cursor_experimental",
      "cursor_tokens_synthetic",
      logs.transcriptSessions
        ? "cursor_from_transcripts"
        : "cursor_from_tracking",
    ],
  });
  if (!local.profile) {
    return { profile, warnings: [...warnings, ...local.warnings] };
  }
  const merged = mergeProfileParts([profile, local.profile], args.plans);
  if (!merged) return { profile, warnings: [...warnings, ...local.warnings] };
  return {
    profile: merged,
    warnings: [...warnings, ...local.warnings],
  };
}

async function withLocalHarnesses(
  profile: Profile,
  args: ScanArgs,
  io: ScanIo,
  offset: number,
  warnings: string[],
): Promise<{ profile: Profile; warnings: string[] }> {
  const withCodex = await maybeMergeLocalCodex(
    profile,
    args,
    io,
    offset,
    warnings,
  );
  return maybeMergeLocalCursor(
    withCodex.profile,
    args,
    io,
    offset,
    withCodex.warnings,
  );
}

async function fromAllAgents(
  args: ScanArgs,
  io: ScanIo,
  offset: number,
): Promise<Assembled & { reader: string }> {
  const range = periodRange(args.period);
  if (!range) {
    return asAssembled(null, [], "", [
      { path: "period", message: "invalid period" },
    ]);
  }
  const loaded = await io.loadCcusage({
    since: range.since,
    until: range.until,
    timeZone: io.timeZone,
  });

  if (!loaded.failed) {
    const multi = profileFromMultiAgent(loaded.reports, {
      period: args.period,
      plans: args.plans,
      utcOffsetMinutes: offset,
    });
    if (multi.profile) {
      const merged = await withLocalHarnesses(
        multi.profile,
        args,
        io,
        offset,
        multi.warnings,
      );
      return asAssembled(merged.profile, merged.warnings, CCUSAGE_READER);
    }
  }

  const local = await fromLocalClaude(args, io, offset, [
    loaded.failed ? "ccusage_failed" : "ccusage_incomplete",
  ]);
  if (!local.profile) return local;
  const merged = await withLocalHarnesses(
    local.profile,
    args,
    io,
    offset,
    local.warnings,
  );
  return asAssembled(
    merged.profile,
    merged.warnings,
    `${local.reader}; local Codex/Cursor when data is present`,
  );
}

async function withDetectedPlans(
  profile: Profile,
  args: ScanArgs,
  io: ScanIo,
  warnings: string[],
): Promise<{ profile: Profile; warnings: string[] }> {
  const sources = new Set<Source>([
    ...(Object.keys(profile.by_source ?? {}) as Source[]),
    ...(Object.keys(profile.provenance) as Source[]),
  ]);
  // Always try Claude/Codex/Cursor auth even if that harness had no usage this period.
  sources.add("claude-code");
  sources.add("codex");
  sources.add("cursor");
  const detected = await detectPlans({
    home: io.home,
    env: io.env,
    sources: [...sources],
  });
  const next = applyDetectedPlans(profile, detected, { cliPlans: args.plans });
  const parsed = parseProfile(next);
  if (!parsed.ok) {
    return {
      profile,
      warnings: [
        ...warnings,
        ...detected.warnings,
        "plan_detect_invalid_profile",
      ],
    };
  }
  return {
    profile: parsed.profile,
    warnings: [...warnings, ...detected.warnings],
  };
}

async function maybeOpen(args: ScanArgs, io: ScanIo, url: string) {
  if (args.noOpen) return;
  const openNow =
    args.yes || (args.json ? false : io.isTTY && accepted(await io.prompt(PROMPT)));
  if (!openNow) {
    if (!args.json && !io.isTTY && !args.yes) {
      io.stderr("No interactive terminal. The verdict stays closed.\n");
    }
    return;
  }
  try {
    await io.open(url);
  } catch {
    io.stderr("Could not open the browser. The URL is in the profile.\n");
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
    ? await fromCodexOnly(args, io, offset)
    : await fromAllAgents(args, io, offset);
  if (!assembled.profile) {
    io.stderr(renderFailure(args.period, assembled.issues, assembled.warnings));
    return 1;
  }
  const enriched = await withDetectedPlans(
    assembled.profile,
    args,
    io,
    assembled.warnings,
  );
  const declared = await withDeclaredPlans(enriched.profile, args, io);
  const profile = declared.profile;
  const scanWarnings = [...enriched.warnings, ...declared.warnings];
  const url = verdictUrl(args.baseUrl, profileToHash(profile));
  if (args.json) {
    io.stdout(`${JSON.stringify(profile, null, 2)}\n`);
    if (
      args.codex ||
      scanWarnings.some(
        (warning) =>
          warning.includes("ccusage") || warning.startsWith("plan_"),
      )
    ) {
      for (const line of noteLines(scanWarnings)) io.stderr(`${line}\n`);
    }
  } else {
    io.stdout(
      `${renderPreview(profile, {
        url,
        warnings: scanWarnings,
        scannedAt: localDay(io.now.getTime(), offset),
        reader: assembled.reader,
      })}\n`,
    );
  }
  await maybeOpen(args, io, url);
  return 0;
}

export function browserOpenSpawn(
  url: string,
  platform: NodeJS.Platform,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // On Windows the URL goes to the shell handler without cmd.exe, so `&`
  // and `%` in it are never interpreted.
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function openUrl(url: string): Promise<void> {
  const spec = browserOpenSpawn(url, process.platform);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
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
