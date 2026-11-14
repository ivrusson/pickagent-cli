import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isDirectCli } from "./cli";

test("the bin symlink named pickagent still counts as the CLI entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pickagent-bin-"));
  const self = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const bin = join(dir, "pickagent");
  await symlink(self, bin);
  assert.equal(isDirectCli(bin), true);
  assert.equal(isDirectCli(self), true);
  assert.equal(isDirectCli(undefined), false);
  assert.equal(isDirectCli(join(dir, "other.js")), false);
  const decoy = join(dir, "cli.js");
  await writeFile(decoy, "#!/usr/bin/env node\n");
  assert.equal(isDirectCli(decoy), false);
});
