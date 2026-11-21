import assert from "node:assert/strict";
import test from "node:test";
import { limitsFrom, type DiscoveredAccount } from "./discover";

test("accepted accounts keep sources discovery does not offer", () => {
  const claude: DiscoveredAccount = {
    id: "claude-1",
    source: "claude-code",
    label: "Claude Code",
    claudeDir: "/tmp/claude",
  };
  const limits = limitsFrom([claude]);
  assert.equal(limits.sources.has("claude-code"), true);
  assert.equal(limits.sources.has("copilot"), true);
  assert.equal(limits.sources.has("amp"), true);
  assert.equal(limits.sources.has("codex"), false);
  assert.equal(limits.sources.has("cursor"), false);
  assert.deepEqual(limits.claudeDirs, ["/tmp/claude"]);
});
