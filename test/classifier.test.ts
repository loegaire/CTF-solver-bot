/**
 * Classifier tests: the continue-vs-stop decision logic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    classify,
    extractStatus,
    extractFlag,
} from "../src/errors/classifier.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function baseResult(overrides: Partial<Parameters<typeof classify>[0]> = {}) {
    return {
        exitCode: 0,
        signal: null,
        killed: false,
        killReason: null,
        spawnError: null,
        lastAssistantText: "",
        transcriptTail: "",
        rawTail: "",
        stderrTail: "",
        providerError: null,
        ...overrides,
    };
}

let tmpCounter = 0;
function tmpWorkspace(): string {
    const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), `ctf-test-${tmpCounter++}-`),
    );
    return dir;
}

test("STATUS: SOLVED marker → SOLVED with flag", () => {
    const out = classify(
        baseResult({
            lastAssistantText: "Done.\n\nSTATUS: SOLVED\nFlag: CTF{test_flag}",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "SOLVED");
    assert.equal(out.flag, "CTF{test_flag}");
});

test("STATUS: UNSOLVED → CONTINUE (not solved is not failure)", () => {
    const out = classify(
        baseResult({
            lastAssistantText: "I could not solve it.\n\nSTATUS: UNSOLVED",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "CONTINUE");
});

test("no STATUS marker → CONTINUE as recoverable default", () => {
    const out = classify(
        baseResult({ lastAssistantText: "I gave up for now." }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "CONTINUE");
});

test("attempts exhausted → BLOCKED", () => {
    const out = classify(
        baseResult({ lastAssistantText: "STATUS: UNSOLVED" }),
        20,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "BLOCKED");
});

test("SOLVED status wins over a trailing provider error (completed conclusion is authoritative)", () => {
    const out = classify(
        baseResult({
            lastAssistantText: "I solved it. Flag: CTF{won}\n\nSTATUS: SOLVED",
            providerError: "429: rate limit exceeded on follow-up request",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "SOLVED");
    assert.equal(out.flag, "CTF{won}");
});

test("UNSOLVED status wins over a trailing provider error → CONTINUE, not FATAL", () => {
    // The live echo-test case: agent concluded UNSOLVED, then the provider
    // rate-limited the very last request. Job must continue, not die.
    const out = classify(
        baseResult({
            lastAssistantText:
                "The challenge appears to be a flagless stub...\n\nSTATUS: UNSOLVED",
            providerError: "429: rate limit exceeded on follow-up request",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "CONTINUE");
});

test("permanent provider error WITHOUT any conclusion → FATAL (it prevented the work)", () => {
    const out = classify(
        baseResult({
            lastAssistantText: "",
            providerError:
                '401: {"message":"invalid api key","type":"api_error"}',
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("provider transport error (pi stopReason=error) → FATAL", () => {
    const out = classify(
        baseResult({
            providerError:
                '403: {"code":"","message":"This token has no access to model","type":"api_error"}',
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
    assert.match(out.reason, /auth failure/);
});

test("503 cache_only_cold (free-tier cold cache) → CONTINUE, not FATAL", () => {
    const out = classify(
        baseResult({
            providerError:
                '503: {"message":"cache-only admission rejected a cold, unavailable, or overloaded request","type":"Service Unavailable","param":"","code":"cache_only_cold"}',
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "CONTINUE");
    assert.match(out.reason, /transient/);
});

test("transient 503 at attempt limit → BLOCKED (not FATAL)", () => {
    const out = classify(
        baseResult({
            providerError:
                '503: {"message":"overloaded request","code":"cache_only_cold"}',
        }),
        20,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "BLOCKED");
});

test("auth/quota provider errors remain FATAL (retrying cannot fix money/keys)", () => {
    const out = classify(
        baseResult({
            providerError:
                '401: {"message":"invalid api key","type":"api_error"}',
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
    const out2 = classify(
        baseResult({
            providerError: "402: insufficient_user_quota — please recharge",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out2.kind, "FATAL");
});

test("429 rate limit → CONTINUE (next rotation is the retry)", () => {
    const out = classify(
        baseResult({
            providerError: "429: rate limit exceeded, retries exhausted",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "CONTINUE");
});

test("provider 429 after all retries → CONTINUE under rotation policy", () => {
    const out = classify(
        baseResult({
            providerError: "429: rate limit exceeded, retries exhausted",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "CONTINUE");
    assert.match(out.reason, /transient/);
});

test("pi CLI startup error on stderr (bad model) → FATAL, not retried", () => {
    const out = classify(
        baseResult({
            exitCode: 1,
            stderrTail:
                'Error: Model "z-ai/nonexistent-model" not found. Use --list-models to see available models.',
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test('agent quoting an "Error:" line in its own report is NOT fatal (completed normally)', () => {
    const out = classify(
        baseResult({
            lastAssistantText:
                "The program printed Error: invalid input, so that path is wrong.\n\nSTATUS: UNSOLVED",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "CONTINUE");
});

test("auth failure in stderr → FATAL", () => {
    const out = classify(
        baseResult({ stderrTail: "Error: 401 Unauthorized: invalid API key" }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
    assert.match(out.reason, /auth failure/);
});

test("rate limit → FATAL", () => {
    const out = classify(
        baseResult({ stderrTail: "HTTP 429: rate limit exceeded" }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("quota exhaustion → FATAL", () => {
    const out = classify(
        baseResult({
            rawTail: "You exceeded your quota. Please upgrade your plan.",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("spawn failure → FATAL", () => {
    const out = classify(
        baseResult({ spawnError: "failed to spawn pi: ENOENT" }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("assistant quoting 403 in analysis text is NOT fatal (transport-only patterns skip assistant text)", () => {
    const out = classify(
        baseResult({
            lastAssistantText:
                "The server returned 403 Forbidden when I probed it, so the endpoint is protected.",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "CONTINUE");
});

test("403 in stderr IS fatal", () => {
    const out = classify(
        baseResult({ stderrTail: "POST /v1/chat: 403 Forbidden" }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("billing required → FATAL", () => {
    const out = classify(
        baseResult({ stderrTail: "error: billing required for this model" }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("permission denied → FATAL", () => {
    const out = classify(
        baseResult({ stderrTail: "EACCES: permission denied, open /root/x" }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("network failure → FATAL", () => {
    const out = classify(
        baseResult({ stderrTail: "fetch failed: ECONNREFUSED 127.0.0.1:443" }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("model unavailable → FATAL", () => {
    const out = classify(
        baseResult({
            stderrTail: "No available provider for model z-ai/glm-5.3-free",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out.kind, "FATAL");
});

test("SOLUTION.md backup: solved marker missing but file says solved", () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(
        path.join(ws, "SOLUTION.md"),
        "# Solution\nStatus: SOLVED\nFlag: FLAG{from_md}\n## Summary\nIt worked.",
    );
    const out = classify(
        baseResult({ lastAssistantText: "It is done." }),
        1,
        20,
        ws,
    );
    assert.equal(out.kind, "SOLVED");
    assert.equal(out.flag, "FLAG{from_md}");
});

test('assistant mentioning "rate limit" conceptually is not fatal, but rate limit error text is', () => {
    // "rate limit" as part of legitimate discussion → should NOT be fatal from assistant text
    const out1 = classify(
        baseResult({
            lastAssistantText:
                "The challenge has a rate limit on the server; I need to slow down my exploit script. STATUS: UNSOLVED",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out1.kind, "CONTINUE");
    // same text in stderr (transport) → fatal
    const out2 = classify(
        baseResult({
            stderrTail: "The challenge has a rate limit on the server",
        }),
        1,
        20,
        tmpWorkspace(),
    );
    assert.equal(out2.kind, "FATAL");
});

test("extractStatus handles markers robustly", () => {
    assert.equal(extractStatus("STATUS: SOLVED"), "SOLVED");
    assert.equal(extractStatus("...\nstatus: unsolved\n"), "UNSOLVED");
    assert.equal(extractStatus("no markers here"), null);
});

test("extractFlag variants", () => {
    assert.equal(extractFlag("Flag: CTF{abc}"), "CTF{abc}");
    assert.equal(extractFlag("**Flag:** `CTF{xyz}`"), "CTF{xyz}");
    assert.equal(extractFlag("nothing"), null);
});
