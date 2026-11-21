import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  mergeProfileParts,
  parseProfile,
  profileFromCcusage,
  profileFromMultiAgent,
  profileToHash,
  splitReportsByAgent,
  type CcusageReports,
  type Issue,
  type Profile,
  type Source,
} from "./profile";
import {
  boundsOf,
  HELP,
  isAgentEnv,
  localOffsetMinutes,
  parseArgs,
  periodRange,
  verdictLangFromEnv,
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
  mergePlanIds,
} from "./detect-plans";
import {
  catalogNames,
  declaredFromCatalog,
  fetchCatalogPrices,
  type CatalogIndex,
} from "./catalog";
import { discoverAccounts, limitsFrom, type ScanLimits } from "./discover";
import { chooseAccounts, choosePlansAndPrices } from "./interview";
import {
  applyDeclaredChoices,
  applyPriceSpecs,
  rememberPlans,
  savedPlans,
  withDeclaredPlans,
} from "./plan-interview";
import { readCursorUsage } from "./cursor-usage";
import { noteLines, renderPreview } from "./preview";
import { clackPrompts, isPromptCancel, type ScanPrompts } from "./prompts";
import { saveScannerConfig, scannerConfigPath } from "./scanner-config";
import {
  applyHourFills,
  readAntigravityFill,
  readCodexHourFill,
  readGeminiFill,
  readKimiFill,
  readOpenCodeFill,
  type HourFill,
} from "./local-hours";
import { localDay, toReports } from "./reports";

const CCUSAGE_READER =
  "npx ccusage@latest daily|session --json --by-agent y blocks --offline --breakdown";

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
    claudeConfigDir?: string;
  }) => Promise<CcusageLoad>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompt: (question: string) => Promise<string>;
  open: (url: string) => Promise<void>;
  /** When set, tests and callers supply the catalog. Otherwise the public API is fetched. */
  loadCatalog?: (env: NodeJS.ProcessEnv) => Promise<CatalogIndex | null>;
  /** When set, the interactive scan uses this instead of @clack/prompts. */
  prompts?: ScanPrompts;
};

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
  claudeDirs?: string[] | null,
): Promise<Assembled & { reader: string }> {
  const bounds = boundsOf(args.period, offset);
  if (!bounds) {
    return asAssembled(null, extraWarnings, "", [
      { path: "period", message: "invalid period" },
    ]);
  }
  const dirs = claudeDirs?.length
    ? claudeDirs
    : await claudeConfigDirs(io.env, io.home);
  const logs = await readClaudeLogs(dirs, bounds, offset);
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
  const cursorHours = profile.by_source?.cursor?.agent_hours ?? 0;
  if (cursorHours > 0) return { profile, warnings };
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
    estimateTime: true,
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
  limits: ScanLimits | null,
): Promise<{ profile: Profile; warnings: string[] }> {
  const allow = (source: Source) => !limits || limits.sources.has(source);
  const withCodex = allow("codex")
    ? await maybeMergeLocalCodex(profile, args, io, offset, warnings)
    : { profile, warnings };
  if (!allow("cursor")) return withCodex;
  return maybeMergeLocalCursor(
    withCodex.profile,
    args,
    io,
    offset,
    withCodex.warnings,
  );
}

function profileForSources(
  reports: CcusageReports,
  options: { period: string; plans: string[]; utcOffsetMinutes: number },
  sources: Set<Source>,
): { profile: Profile | null; warnings: string[] } {
  const split = splitReportsByAgent(reports);
  if (split.size === 0) {
    if (!sources.has("claude-code")) return { profile: null, warnings: [] };
    return profileFromMultiAgent(reports, options);
  }
  const parts: Profile[] = [];
  const warnings: string[] = [];
  for (const [source, partReports] of split) {
    if (!sources.has(source)) continue;
    const result = profileFromCcusage(partReports, { ...options, source });
    warnings.push(...result.warnings.map((warning) => `${source}:${warning}`));
    if (result.profile) parts.push(result.profile);
  }
  return { profile: mergeProfileParts(parts, options.plans), warnings };
}

async function fromAllAgents(
  args: ScanArgs,
  io: ScanIo,
  offset: number,
  limits: ScanLimits | null = null,
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
    claudeConfigDir: limits?.claudeDirs?.join(","),
  });
  const options = {
    period: args.period,
    plans: args.plans,
    utcOffsetMinutes: offset,
  };

  if (!loaded.failed) {
    const multi = limits
      ? profileForSources(loaded.reports, options, limits.sources)
      : profileFromMultiAgent(loaded.reports, options);
    if (multi.profile) {
      const merged = await withLocalHarnesses(
        multi.profile,
        args,
        io,
        offset,
        multi.warnings,
        limits,
      );
      return asAssembled(merged.profile, merged.warnings, CCUSAGE_READER);
    }
  }

  if (limits && !limits.sources.has("claude-code")) {
    return fromSelectedLocals(args, io, offset, limits, [
      loaded.failed ? "ccusage_failed" : "ccusage_incomplete",
    ]);
  }

  const local = await fromLocalClaude(
    args,
    io,
    offset,
    [loaded.failed ? "ccusage_failed" : "ccusage_incomplete"],
    limits?.claudeDirs,
  );
  if (!local.profile) return local;
  const merged = await withLocalHarnesses(
    local.profile,
    args,
    io,
    offset,
    local.warnings,
    limits,
  );
  return asAssembled(
    merged.profile,
    merged.warnings,
    `${local.reader}; local Codex/Cursor when data is present`,
  );
}

async function fromSelectedLocals(
  args: ScanArgs,
  io: ScanIo,
  offset: number,
  limits: ScanLimits,
  warnings: string[],
): Promise<Assembled & { reader: string }> {
  const parts: Profile[] = [];
  const notes = [...warnings];
  if (limits.sources.has("codex")) {
    const codex = await fromCodexOnly(args, io, offset);
    notes.push(...codex.warnings);
    if (codex.profile) parts.push(codex.profile);
  }
  if (limits.sources.has("cursor")) {
    const bounds = boundsOf(args.period, offset);
    if (bounds) {
      const logs = await readCursorUsage(io.env, io.home, bounds, offset);
      if (logs.sessions.size > 0) {
        const local = assembleProfile({
          reports: toReports(logs),
          hits: logs.hits,
          period: args.period,
          plans: args.plans,
          source: "cursor",
          utcOffsetMinutes: offset,
          estimateTokens: true,
          estimateTime: true,
          limitHitsKnown: true,
          extraWarnings: [
            "cursor_experimental",
            "cursor_tokens_synthetic",
            logs.transcriptSessions ? "cursor_from_transcripts" : "cursor_from_tracking",
          ],
        });
        notes.push(...local.warnings);
        if (local.profile) parts.push(local.profile);
      }
    }
  }
  return asAssembled(
    mergeProfileParts(parts, args.plans),
    notes,
    "selected local readers",
  );
}

async function withDetectedPlans(
  profile: Profile,
  args: ScanArgs,
  io: ScanIo,
  warnings: string[],
  limits: ScanLimits | null,
): Promise<{ profile: Profile; warnings: string[] }> {
  const sources = new Set<Source>([
    ...(Object.keys(profile.by_source ?? {}) as Source[]),
    ...(Object.keys(profile.provenance) as Source[]),
  ]);
  if (limits) {
    for (const source of limits.sources) sources.add(source);
  } else {
    // Always try Claude/Codex/Cursor auth even if that harness had no usage this period.
    sources.add("claude-code");
    sources.add("codex");
    sources.add("cursor");
  }
  const detected = await detectPlans({
    home: io.home,
    env: io.env,
    sources: [...sources],
  });
  const next = applyDetectedPlans(profile, detected, {
    cliPlans: mergePlanIds(detected.plans, args.plans),
  });
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

async function fillZeroHours(
  profile: Profile,
  args: ScanArgs,
  io: ScanIo,
  offset: number,
  limits: ScanLimits | null,
): Promise<Profile> {
  const bounds = boundsOf(args.period, offset);
  if (!bounds) return profile;
  const allow = (source: Source) => !limits || limits.sources.has(source);
  const missing = (source: Source) => {
    const slice = profile.by_source?.[source];
    return !slice || slice.agent_hours <= 0;
  };
  const fills: HourFill[] = [];
  const take = async (source: Source, read: () => Promise<HourFill | null>) => {
    if (!allow(source) || !missing(source)) return;
    const fill = await read();
    if (fill) fills.push(fill);
  };
  await take("opencode", () => readOpenCodeFill(io.home, bounds, offset));
  await take("kimi-cli", () => readKimiFill(io.home, bounds, offset));
  await take("codex", () => readCodexHourFill(io.env, io.home, bounds, offset));
  await take("gemini-cli", () => readGeminiFill(io.home, bounds, offset));
  await take("antigravity", () => readAntigravityFill(io.home, bounds, offset));
  return applyHourFills(profile, fills);
}

function wantsPrompts(args: ScanArgs, io: ScanIo): boolean {
  return io.isTTY && !args.json && !args.yes && !isAgentEnv(io.env);
}

async function loadCatalog(io: ScanIo): Promise<CatalogIndex | null> {
  if (io.loadCatalog) return io.loadCatalog(io.env);
  return fetchCatalogPrices(io.env);
}

function fillCatalogPrices(profile: Profile, catalog: CatalogIndex | null): Profile {
  if (!catalog) return profile;
  const prices = { ...(profile.plan_prices ?? {}) };
  let changed = false;
  for (const planId of profile.plans) {
    if (prices[planId]) continue;
    const plan = catalog.byId.get(planId);
    const price = plan ? declaredFromCatalog(plan) : null;
    if (!price) continue;
    prices[planId] = price;
    changed = true;
  }
  if (!changed) return profile;
  return applyDeclaredChoices(profile, profile.plans, prices);
}

async function acceptDefaults(
  profile: Profile,
  args: ScanArgs,
  io: ScanIo,
): Promise<{ profile: Profile; catalog: CatalogIndex | null; warnings: string[] }> {
  const config = await savedPlans(io);
  const remembered = Boolean(
    config.plans?.length ||
      (config.plan_prices && Object.keys(config.plan_prices).length > 0),
  );
  let next = profile;
  const warnings: string[] = [];
  if (args.yes && remembered) {
    next = applyDeclaredChoices(
      next,
      mergePlanIds(config.plans?.length ? config.plans : next.plans, args.plans),
      { ...(config.plan_prices ?? {}) },
    );
  } else {
    const declared = await withDeclaredPlans(next, args, io);
    next = declared.profile;
    warnings.push(...declared.warnings);
  }
  next = applyPriceSpecs(next, args.prices);
  let catalog: CatalogIndex | null = null;
  if (args.yes && next.plans.some((planId) => !next.plan_prices?.[planId])) {
    catalog = await loadCatalog(io);
    next = fillCatalogPrices(next, catalog);
  }
  const parsed = parseProfile(next);
  if (!parsed.ok) return { profile, catalog, warnings: [...warnings, "plan_price_invalid"] };
  return { profile: parsed.profile, catalog, warnings };
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
  const prompts = wantsPrompts(args, io) ? (io.prompts ?? clackPrompts()) : null;
  let limits: ScanLimits | null = null;
  if (prompts && !args.codex) {
    prompts.intro("pickagent scan");
    const accounts = await prompts.spin("Looking for accounts", () =>
      discoverAccounts(io.env, io.home),
    );
    const chosen = await chooseAccounts(prompts, accounts);
    if (isPromptCancel(chosen)) {
      prompts.cancel("Cancelled.");
      return 0;
    }
    if (chosen.length) limits = limitsFrom(chosen);
  }

  const scanOnce = () =>
    args.codex
      ? fromCodexOnly(args, io, offset)
      : fromAllAgents(args, io, offset, limits);
  const assembled = prompts
    ? await prompts.spin("Scanning", scanOnce)
    : await scanOnce();
  if (!assembled.profile) {
    io.stderr(renderFailure(args.period, assembled.issues, assembled.warnings));
    return 1;
  }
  const timed = await fillZeroHours(assembled.profile, args, io, offset, limits);
  const enriched = await withDetectedPlans(timed, args, io, assembled.warnings, limits);

  let profile = enriched.profile;
  let names: Record<string, string> = {};
  const scanWarnings = [...enriched.warnings];
  if (prompts) {
    const catalog = await loadCatalog(io);
    names = catalogNames(catalog);
    const choice = await choosePlansAndPrices({
      prompts,
      detected: profile.plans,
      forced: args.plans,
      specs: args.prices,
      config: await savedPlans(io),
      catalog,
    });
    if (isPromptCancel(choice)) {
      prompts.cancel("Cancelled.");
      return 0;
    }
    const chosen = applyDeclaredChoices(profile, choice.plans, choice.prices);
    const parsed = parseProfile(chosen);
    if (!parsed.ok) {
      scanWarnings.push("plan_price_invalid");
    } else {
      profile = parsed.profile;
      const memory = rememberPlans(choice.plans, choice.prices);
      if (memory.plans?.length || memory.plan_prices) {
        await saveScannerConfig(scannerConfigPath(io.home), memory);
      }
    }
  } else {
    const resolved = await acceptDefaults(profile, args, io);
    profile = resolved.profile;
    names = catalogNames(resolved.catalog);
    scanWarnings.push(...resolved.warnings);
    if (args.yes || args.prices.length) {
      const memory = rememberPlans(profile.plans, profile.plan_prices ?? {});
      if (memory.plans?.length || memory.plan_prices) {
        await saveScannerConfig(scannerConfigPath(io.home), memory);
      }
    }
  }

  const lang = args.lang ?? verdictLangFromEnv(io.env);
  const url = verdictUrl(args.baseUrl, profileToHash(profile), lang);
  const scannedAt = localDay(io.now.getTime(), offset);
  if (args.json) {
    io.stdout(`${JSON.stringify(profile, null, 2)}\n`);
    if (args.verbose) {
      for (const line of noteLines(scanWarnings)) io.stderr(`${line}\n`);
    }
  } else {
    io.stdout(
      `${renderPreview(profile, {
        url,
        warnings: scanWarnings,
        scannedAt,
        reader: assembled.reader,
        verbose: args.verbose,
        names,
      })}\n`,
    );
  }

  let opened = false;
  if (!args.noOpen && (args.yes || (prompts && !args.json))) {
    let openNow = args.yes;
    if (!openNow && prompts) {
      const answer = await prompts.confirm({ message: "Open verdict" });
      if (isPromptCancel(answer)) {
        prompts.cancel("Cancelled.");
        return 0;
      }
      openNow = answer;
    }
    if (openNow) {
      try {
        await io.open(url);
        opened = true;
      } catch {
        io.stderr("Could not open the browser.\n");
      }
    }
  } else if (!args.json && !args.yes && !io.isTTY) {
    io.stderr("No interactive terminal. The verdict stays closed.\n");
  }
  if (!opened) {
    if (args.json) io.stderr(`${url}\n`);
    else io.stdout(`${url}\n`);
  }
  if (prompts) prompts.outro(opened ? "Opened the verdict." : "Done.");
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
      loadCcusage({
        ...input,
        env: input.claudeConfigDir
          ? { ...process.env, CLAUDE_CONFIG_DIR: input.claudeConfigDir }
          : process.env,
      }),
    loadCatalog: (env) => fetchCatalogPrices(env),
    prompts: clackPrompts(),
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
