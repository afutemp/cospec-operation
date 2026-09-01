import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalIdentityStore } from "./terminal-identity.js";

test("terminal identity is stable across collector instances and contains no machine fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-terminal-id-"));
  try {
    const first = await new TerminalIdentityStore(root).getOrCreate();
    const second = await new TerminalIdentityStore(root).getOrCreate();
    assert.equal(second, first);
    const stored = JSON.parse(await readFile(join(root, "installation.json"), "utf8"));
    assert.deepEqual(Object.keys(stored).sort(), ["anonymousTerminalId", "createdAt", "schemaVersion"]);
    if (process.platform !== "win32") {
      const mode = (await import("node:fs/promises")).stat(join(root, "installation.json")).then((value) => value.mode & 0o777);
      assert.equal(await mode, 0o600);
    }
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or invalid identity is regenerated", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-terminal-id-invalid-"));
  try {
    const store = new TerminalIdentityStore(root);
    const first = await store.getOrCreate();
    await (await import("node:fs/promises")).writeFile(store.path, "invalid\n", "utf8");
    const regenerated = await store.getOrCreate();
    assert.notEqual(regenerated, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
