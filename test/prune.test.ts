/**
 * Repo-sync prune tests: challenges deleted from the source are closed out.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as db from "../src/database/db.js";
import { LocalSource } from "../src/sources/local.js";
import { Lifecycle } from "../src/dispatcher/lifecycle.js";

let root: string;
let srcDir: string;
let jobsDir: string;

function writeChallenge(name: string, files: Record<string, string>): void {
   const dir = path.join(srcDir, name);
   fs.mkdirSync(dir, { recursive: true });
   for (const [f, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, f), content);
   }
}

beforeEach(() => {
   root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
   srcDir = path.join(root, "source");
   jobsDir = path.join(root, "jobs");
   fs.mkdirSync(srcDir, { recursive: true });
   db.openDb(path.join(root, "db.sqlite"));
});

test("pruneMissing closes jobs + challenges deleted from the source", async () => {
   writeChallenge("keep-me", { "README.md": "# keep" });
   writeChallenge("gone-later", { "README.md": "# gone" });

   const src = new LocalSource(srcDir, "");
   const lifecycle = new Lifecycle(src, jobsDir, {
      maxAttempts: 20,
      turnMinutes: 10,
   });
   const { groupChallenges } = await import("../src/sources/source.js");
   const rev1 = await src.currentRevision();
   const batch1 = groupChallenges("", await src.listFiles(), rev1);
   await lifecycle.discover(batch1, []);

   // both discovered
   const paths = db.getTrackedChallengePaths(src.id);
   assert.ok(paths.includes("keep-me"));
   assert.ok(paths.includes("gone-later"));

   // simulate the challenge being deleted from the repo
   fs.rmSync(path.join(srcDir, "gone-later"), { recursive: true });
   const rev2 = await src.currentRevision();
   const batch2 = groupChallenges("", await src.listFiles(), rev2);

   let stopCalled = 0;
   const stopped = lifecycle.pruneMissing(batch2, () => {
      stopCalled++;
   });

   const pathsAfter = db.getTrackedChallengePaths(src.id);
   assert.ok(pathsAfter.includes("keep-me"));
   assert.ok(
      !pathsAfter.includes("gone-later"),
      "deleted challenge no longer tracked",
   );

   // Source-of-truth purge: the deleted challenge's rows are GONE from the
   // DB entirely (not tombstoned) — the repo is the source of truth.
   const goneCh = db.getChallengesBySourcePath(src.id, "gone-later");
   assert.equal(goneCh.length, 0, "deleted challenge purged from DB entirely");
   assert.equal(stopCalled, 0); // job was NEW (not RUNNING), no kill needed
   assert.ok(stopped >= 0);
});

test("pruneMissing is a no-op when nothing was deleted", async () => {
   writeChallenge("stable", { "README.md": "# stable" });
   const src = new LocalSource(srcDir, "");
   const lifecycle = new Lifecycle(src, jobsDir, {
      maxAttempts: 20,
      turnMinutes: 10,
   });
   const { groupChallenges } = await import("../src/sources/source.js");
   const rev = await src.currentRevision();
   const batch = groupChallenges("", await src.listFiles(), rev);
   await lifecycle.discover(batch, []);
   const before = db.getTrackedChallengePaths(src.id).length;
   const n = lifecycle.pruneMissing(batch, () => {});
   assert.equal(n, 0);
   assert.equal(db.getTrackedChallengePaths(src.id).length, before);
});
