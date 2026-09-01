import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollectorEventLog } from "./event-log.js";

test("event log writes JSONL, omits unspecified sensitive fields and rotates", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-event-log-"));
  const log = new CollectorEventLog(root, 180, 2);
  for (let index = 0; index < 8; index += 1) {
    await log.write({ level: "error", event: "scan_failed", code: "upload_network_error", consecutive_failures: index + 1 });
  }
  const files = (await readdir(join(root, "logs"))).sort();
  assert.deepEqual(files, ["collector.jsonl", "collector.jsonl.1", "collector.jsonl.2"]);
  for (const file of files) {
    const content = await readFile(join(root, "logs", file), "utf8");
    for (const line of content.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
    assert.equal(/token|authorization|canonicalPath|stack/.test(content), false);
  }
});
