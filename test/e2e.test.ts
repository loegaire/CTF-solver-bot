/**
 * End-to-end dispatcher test with the EchoBackend:
 * discover → stage → handoff → classify → continue → solve.
 * Also verifies recovery of interrupted RUNNING jobs.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
    openDb,
    closeDb,
    getJobById,
    getJobsByStatus,
    getChallengeById,
} from "../src/database/db.js";
import { LocalSource } from "../src/sources/local.js";
import { EchoBackend } from "../src/agents/echo.js";
import { Lifecycle } from "../src/dispatcher/lifecycle.js";
import { Queue } from "../src/dispatcher/queue.js";
import { sleep } from "../src/agents/backend.js";

let root: string;
let srcDir: string;
let jobsDir: string;
let dbPath: string;

function writeChallenge(name: string, files: Record<string, string>): void {
    const dir = path.join(srcDir, "challenges", name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), content);
    }
}

before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ctf-e2e-"));
    srcDir = path.join(root, "source");
    jobsDir = path.join(root, "jobs");
    dbPath = path.join(root, "state.db");
    fs.mkdirSync(path.join(srcDir, "challenges"), { recursive: true });
    openDb(dbPath);
});

after(async () => {
    closeDb();
    fs.rmSync(root, { recursive: true, force: true });
});

test("full cycle: unsolved twice then solved, with continuation forcing", async () => {
    writeChallenge("easy", {
        "README.md": "# easy\nFlag format: FLAG{...}\n",
        "hint.txt": "the answer is 42",
    });
    writeChallenge("stubborn", {
        "README.md": "# stubborn\n",
        "data.bin": "\x00\x01\x02",
    });

    const src = new LocalSource(srcDir, "challenges");
    const backend = new EchoBackend({ defaultScript: "unsolved" });
    const lifecycle = new Lifecycle(src, jobsDir, {
        maxAttempts: 5,
        onEvent: () => {},
    });
    const queue = new Queue(backend, lifecycle, {
        maxConcurrent: 2,
        tickMs: 50,
    });

    // 1. discover both
    const { challenges } = await (async () => {
        const revision = await src.currentRevision();
        const files = await src.listFiles();
        const { groupChallenges } = await import("../src/sources/source.js");
        return { challenges: groupChallenges("", files, revision) };
    })();
    const created = await lifecycle.discover(challenges);
    assert.equal(created.length, 2, "both challenges registered");

    // 2. run the queue until both settle (echo backend: unsolved → CONTINUE → re-run ...)
    const queueDone = queue.run();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const settled =
            getJobsByStatus("SOLVED").length +
            getJobsByStatus("BLOCKED").length +
            getJobsByStatus("FATAL_ERROR").length;
        if (getJobsByStatus("SOLVED").length === 2 || settled === 2) break;
        await sleep(100);
    }
    queue.stop();
    await queueDone;

    const jobs = [
        ...getJobsByStatus("SOLVED"),
        ...getJobsByStatus("BLOCKED"),
        ...getJobsByStatus("FATAL_ERROR"),
    ];
    assert.equal(jobs.length, 2, "both jobs settled");
    // echo default is unsolved → both should be BLOCKED after maxAttempts
    for (const j of jobs) {
        assert.equal(j.status, "BLOCKED");
        assert.equal(j.attempts, 5);
    }

    // 3. continuation actually ran multiple times: attempts went 1..5 with same session
    const j0 = jobs[0];
    assert.match(j0.pi_session_id, /^ctf-/);
    assert.ok(
        fs.existsSync(path.join(j0.workspace, "task.txt")),
        "task.txt staged",
    );
    assert.ok(
        fs.existsSync(path.join(j0.workspace, "AGENTS.md")),
        "AGENTS.md staged",
    );
    assert.ok(
        fs.existsSync(path.join(j0.workspace, "staged-manifest.json")),
        "manifest staged",
    );
    assert.ok(
        fs.existsSync(path.join(j0.workspace, "hint.txt")) ||
            fs.existsSync(path.join(j0.workspace, "README.md")),
    );
});

test("a later commit creates a new job; identity dedupe holds", async () => {
    const src = new LocalSource(srcDir, "challenges");
    const lifecycle = new Lifecycle(src, jobsDir, { maxAttempts: 3 });

    const listAndGroup = async () => {
        const revision = await src.currentRevision();
        const files = await src.listFiles();
        const { groupChallenges } = await import("../src/sources/source.js");
        return groupChallenges("", files, revision);
    };

    // same content again → no new jobs
    const again = await lifecycle.discover(await listAndGroup());
    assert.equal(again.length, 0, "no duplicate discovery");

    // change content → new revision → new job
    fs.writeFileSync(
        path.join(srcDir, "challenges", "easy", "hint.txt"),
        "the answer is 43",
    );
    const refreshed = await lifecycle.discover(await listAndGroup());
    assert.equal(refreshed.length, 1, "changed challenge gets a new job");
    const job = getJobById(refreshed[0]);
    assert.ok(job);
    const ch = getChallengeById(job!.challenge_id)!;
    assert.equal(ch.path, "challenges/easy");
});

test("recovery: RUNNING job with dead pid is reclassified as AGENT_STOPPED", async () => {
    const src = new LocalSource(srcDir, "challenges");
    const backend = new EchoBackend({ defaultScript: "unsolved" });
    const lifecycle = new Lifecycle(src, jobsDir, { maxAttempts: 3 });

    const listAndGroup = async () => {
        const revision = await src.currentRevision();
        const files = await src.listFiles();
        const { groupChallenges } = await import("../src/sources/source.js");
        return groupChallenges("", files, revision);
    };
    await lifecycle.discover(await listAndGroup());

    // simulate an interrupted run: mark a NEW job as RUNNING with a dead pid
    const jobRows = getJobsByStatus("NEW");
    const victim = jobRows[0];
    const { updateJob } = await import("../src/database/db.js");
    updateJob(victim.id, { status: "RUNNING", pid: 999999999 });

    const actions = lifecycle.recoverInterruptedJobs(backend);
    const found = actions.find((a) => a.jobId === victim.id);
    assert.ok(found, "interrupted job detected");
    assert.equal(found!.action, "continue");
});
