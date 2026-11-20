import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProfile } from "./profile";
import {
  buildNpxSpawn,
  ccusageArgv,
  envForCcusage,
  resolveNpxCli,
  type CcusageLoad,
} from "./ccusage-run";
import { browserOpenSpawn, runScan, type ScanIo } from "./scan";

const now = new Date("2026-11-05T12:00:00.000Z");

const daily = {
  daily: [
    {
      date: "2026-10-05",
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 100,
      cacheReadTokens: 500,
      modelsUsed: ["claude-sonnet-4-5-20250929"],
      modelBreakdowns: [
        {
          modelName: "claude-sonnet-4-5-20250929",
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 100,
          cacheReadTokens: 500,
        },
      ],
    },
  ],
};

const sessions = {
  sessions: [
    {
      models: ["claude-sonnet-4-5-20250929"],
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 100,
      cacheReadTokens: 500,
      firstActivity: "2026-10-05T08:00:00.000Z",
      lastActivity: "2026-10-05T10:00:00.000Z",
      modelBreakdowns: [
        {
          modelName: "claude-sonnet-4-5-20250929",
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 100,
          cacheReadTokens: 500,
        },
      ],
    },
  ],
};

function io(load: CcusageLoad, home: string): ScanIo & { out: string; err: string; opened: string[] } {
  const state = { out: "", err: "", opened: [] as string[] };
  return {
    ...state,
    env: {},
    home,
    now,
    timeZone: "UTC",
    isTTY: true,
    loadCcusage: () => Promise.resolve(load),
    stdout: (text) => {
      state.out += text;
    },
    stderr: (text) => {
      state.err += text;
    },
    prompt: () => Promise.resolve("n"),
    open: (url) => {
      state.opened.push(url);
      return Promise.resolve();
    },
    get out() {
      return state.out;
    },
    get err() {
      return state.err;
    },
    get opened() {
      return state.opened;
    },
  };
}

test("ccusage JSON is printed as a valid profile and the browser stays shut", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-empty-"));
  const scan = io({ failed: false, reports: { daily, sessions } }, home);
  const code = await runScan(
    ["scan", "--period", "2026-10", "--plan", "claude-pro", "--json", "--no-open"],
    scan,
  );
  assert.equal(code, 0);
  assert.equal(scan.opened.length, 0);
  assert.equal(scan.out.includes("SECRET"), false);
  const parsed = parseProfile(JSON.parse(scan.out) as unknown);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.profile.schema, "pickagent.profile/v1");
    assert.equal(parsed.profile.agent_hours.provenance, "measured");
    assert.deepEqual(parsed.profile.plans, ["claude-pro"]);
  }
});

test("a machine without logs exits non-zero and does not throw", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-none-"));
  const scan = io({ failed: true, reports: {} }, home);
  const code = await runScan(["scan", "--period", "2026-10", "--json", "--no-open"], scan);
  assert.equal(code, 1);
  assert.equal(scan.out, "");
  assert.match(scan.err, /No valid profile/);
  assert.equal(scan.err.includes("does not report when the cap is hit"), false);
  assert.equal(scan.opened.length, 0);
});

test("npx on Windows does not spawn npx.cmd, and start quotes the URL", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const npxCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js";
  const viaNode = buildNpxSpawn(["--yes", "ccusage@latest"], {
    platform: "win32",
    execPath,
    npxCliPath: npxCli,
  });
  assert.equal(viaNode.shell, false);
  assert.equal(viaNode.command, execPath);
  assert.deepEqual(viaNode.args, [npxCli, "--yes", "ccusage@latest"]);

  const viaCmd = buildNpxSpawn(["--yes", "ccusage@latest", "a&b"], {
    platform: "win32",
    execPath,
    npxCliPath: null,
  });
  assert.equal(viaCmd.command, "cmd.exe");
  assert.equal(viaCmd.shell, false);
  assert.equal(viaCmd.windowsVerbatimArguments, true);
  assert.deepEqual(viaCmd.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.equal(viaCmd.args[4], '""npx.cmd" "--yes" "ccusage@latest" "a&b""');

  const unix = buildNpxSpawn(["--yes", "ccusage@latest"], {
    platform: "linux",
    execPath: "/usr/bin/node",
    npxCliPath: null,
  });
  assert.deepEqual(unix, {
    command: "npx",
    args: ["--yes", "ccusage@latest"],
    shell: false,
  });

  const found = resolveNpxCli(execPath, (candidate) => candidate === npxCli);
  assert.equal(found, npxCli);
  assert.equal(resolveNpxCli(execPath, () => false), null);

  const url = "https://x.example/a%20b/en/veredicto#p=a&b";
  const open = browserOpenSpawn(url, "win32");
  assert.equal(open.command, "rundll32");
  assert.deepEqual(open.args, ["url.dll,FileProtocolHandler", url]);
  assert.equal(open.windowsVerbatimArguments, undefined);
});

test("ccusage uses unified reports with --by-agent and strips API keys", () => {
  assert.deepEqual(ccusageArgv("daily", "2026-10-01", "2026-10-31", "Europe/Madrid"), [
    "--yes",
    "ccusage@latest",
    "daily",
    "--json",
    "--no-cost",
    "--offline",
    "--since",
    "2026-10-01",
    "--until",
    "2026-10-31",
    "--timezone",
    "Europe/Madrid",
    "--breakdown",
    "--by-agent",
  ]);
  const blocks = ccusageArgv("blocks", "2026-10-01", "2026-10-31", null);
  assert.equal(blocks.includes("claude"), false);
  assert.equal(blocks.includes("--breakdown"), false);
  assert.equal(blocks.includes("--by-agent"), false);
  assert.ok(blocks.includes("blocks"));

  const env = envForCcusage({
    PATH: "/usr/bin",
    Path: "C:\\Windows\\system32",
    HOME: "/home/me",
    USERPROFILE: "C:\\Users\\me",
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    TZ: "Europe/Madrid",
    LANG: "es_ES.UTF-8",
    LANGUAGE: "es_ES",
    LC_ALL: "es_ES.UTF-8",
    LC_SECRET: "nope-secret",
    TMPDIR: "/tmp",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    SystemRoot: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE",
    CLAUDE_CONFIG_DIR: "/tmp/claude",
    CODEX_HOME: "/tmp/codex",
    npm_config_registry: "https://registry.npmmirror.com",
    HTTP_PROXY: "http://proxy:8080",
    HTTPS_PROXY: "http://proxy:8080",
    NO_PROXY: "localhost",
    http_proxy: "http://proxy:8080",
    https_proxy: "http://proxy:8080",
    no_proxy: "localhost",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    ANTHROPIC_API_KEY: "sk-secret",
    OPENAI_API_KEY: "sk-secret",
    NODE_AUTH_TOKEN: "npm-token",
    NPM_TOKEN: "npm-token",
    GITHUB_TOKEN: "gh-token",
    GH_TOKEN: "gh-token",
    HF_TOKEN: "hf-token",
    OPENROUTER_API_KEY: "or-secret",
    MISTRAL_API_KEY: "mistral-secret",
    GROQ_API_KEY: "groq-secret",
    XAI_API_KEY: "xai-secret",
    DATABASE_URL: "postgres://secret",
    "npm_config_//registry.npmjs.org/:_authToken": "auth-leaked",
    npm_config__auth: "auth-leaked",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    USER: "me",
    NODE_OPTIONS: "--require /tmp/evil",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "COMSPEC",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "LOG_LEVEL",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "Path",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "npm_config_registry",
  ]);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude");
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(env.npm_config_registry, "https://registry.npmmirror.com");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/ssl/cert.pem");
  assert.equal(env.LOG_LEVEL, "0");
  assert.equal(env.LC_SECRET, undefined);
  assert.equal(env.LANGUAGE, undefined);
  assert.equal(env.USER, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  const dumped = JSON.stringify(env);
  for (const secret of ["sk-secret", "npm-token", "gh-token", "hf-token", "auth-leaked", "aws-secret", "postgres://secret"]) {
    assert.equal(dumped.includes(secret), false, secret);
  }
});

test("--yes opens the verdict URL and a refusal does not", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-open-"));
  const opened = io({ failed: false, reports: { daily, sessions } }, home);
  const code = await runScan(["scan", "--period", "2026-10", "--yes"], opened);
  assert.equal(code, 0);
  assert.equal(opened.opened.length, 1);
  assert.match(opened.opened[0] ?? "", /^https:\/\/pickagent\.dev\/en\/veredicto#p=/);
  assert.match(opened.out, /measured/);
  assert.match(opened.out, /2026-10/);

  const refused = io({ failed: false, reports: { daily, sessions } }, home);
  const declined = await runScan(["scan", "--period", "2026-10"], refused);
  assert.equal(declined, 0);
  assert.equal(refused.opened.length, 0);
});
