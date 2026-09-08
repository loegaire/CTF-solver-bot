/**
 * Outcome classifier: decides SOLVED / FATAL / CONTINUE / BLOCKED from an agent
 * run result. This is the "continue vs stop" decision point of the whole system.
 *
 * Order of checks:
 *   1. spawn failure, auth/quota/network fatal patterns → FATAL
 *   2. STATUS: SOLVED marker (or SOLUTION.md with a flag) → SOLVED
 *   3. STATUS: UNSOLVED / no marker → CONTINUE (recoverable: force another run)
 *   4. attempts exhausted → BLOCKED (gave it N honest tries; needs human)
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Outcome =
    | { kind: "SOLVED"; flag: string | null; summary: string }
    | { kind: "CONTINUE"; summary: string; reason: string }
    | { kind: "FATAL"; summary: string; reason: string }
    | { kind: "BLOCKED"; summary: string; reason: string };

/** Regexes matching infrastructure errors that no amount of retrying can fix. */
const FATAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
    // HTTP-ish auth/permission/quota errors
    {
        re: /\b40[13]\b[^\n]{0,80}\b(auth|permission|api[ _-]?key|token|forbidden|unauthorized)/i,
        label: "auth failure",
    },
    { re: /\b(auth|permission)[^\n]{0,80}\b40[13]\b/i, label: "auth failure" },
    {
        re: /\b(401|403)\b[^\n]{0,80}(unauthorized|forbidden)/i,
        label: "auth failure",
    },
    { re: /\b429\b|\brate[ _-]?limit(ed)?\b/i, label: "rate limit" },
    {
        re: /\bquota\b|\b(insufficient|exceeded)[^\n]{0,30}(credit|balance|fund)/i,
        label: "quota exhausted",
    },
    { re: /\bbilling\b|\bpayment required\b/i, label: "billing required" },
    {
        re: /\bapi[ _-]?key[^\n]{0,60}(invalid|missing|expired|not valid|rejected)/i,
        label: "invalid API key",
    },
    {
        re: /\b(invalid|missing|expired)[^\n]{0,30}api[ _-]?key\b/i,
        label: "invalid API key",
    },
    // environment/infrastructure failures
    // pi CLI startup errors: printed to stderr as "Error: ..." with empty stdout;
    // agent tool output never appears on pi's stderr, so this is precise.
    { re: /^\s*Error:\s+\S/m, label: "agent CLI error" },
    {
        re: /\bexecutable\b[^\n]{0,40}\bnot found\b|\bno such file\b[^\n]{0,40}\bpi\b/i,
        label: "pi executable unavailable",
    },
    {
        re: /\bno models?\b|\bno (available )?provider\b|\bmodel unavailable\b|\bno api key configured\b/i,
        label: "model unavailable",
    },
    { re: /\bpermission denied\b/i, label: "permission denied" },
    { re: /\bEACCES\b|\bEISDIR\b/i, label: "filesystem error" },
    {
        re: /\bENOTFOUND\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|\bETIMEDOUT\b/i,
        label: "network failure",
    },
    { re: /\bENOSPC\b|\bEMFILE\b|\bENOMEM\b/i, label: "resource exhaustion" },
    { re: /\bsegmentation fault\b/i, label: "crash" },
];

/**
 * Patterns for fatal infrastructure failures reported by an agent that
 * nevertheless completed its final message ("I can't continue because ...").
 * These are intentionally much more specific than the transport patterns.
 */
const AGENT_REPORTED_FATAL: Array<{ re: RegExp; label: string }> = [
    {
        re: /(?:cannot|unable to|can'?t|failed to)\s+(?:continue|proceed|make (?:any )?progress|do anything|reach|access)[^\n]{0,140}\b(auth|api[ _-]?key|quota|billing|rate[ _-]?limit|401|403|429)\b/i,
        label: "agent-reported auth/quota error",
    },
    {
        re: /\b(auth|api[ _-]?key|quota|billing|rate[ _-]?limit|401|403|429)\b[^\n]{0,140}\b(?:cannot|unable to|can'?t)\s+(?:continue|proceed|make (?:any )?progress|do anything)\b/i,
        label: "agent-reported auth/quota error",
    },
    {
        re: /\bapi[ _-]?key[^\n]{0,60}(invalid|missing|expired|not valid|rejected)/i,
        label: "invalid API key",
    },
    {
        re: /\bquota (?:exceeded|exhausted)\b|\bpayment required\b|\bbilling (?:required|issue)\b/i,
        label: "quota/billing exhausted",
    },
];

export function classify(
    result: {
        exitCode: number | null;
        signal: string | null;
        killed: boolean;
        killReason: string | null;
        spawnError: string | null;
        lastAssistantText: string;
        transcriptTail: string;
        rawTail: string;
        stderrTail: string;
        providerError: string | null;
    },
    attempts: number,
    maxAttempts: number,
    workspace: string,
): Outcome {
    // 1. spawn failure is always fatal
    if (result.spawnError) {
        return {
            kind: "FATAL",
            summary: result.spawnError,
            reason: `spawn failure: ${result.spawnError}`,
        };
    }

    // 2. A completed run with a clean STATUS verdict is authoritative — even if a
    // transient provider error surfaced on the very last message (e.g. the
    // follow-up request rate-limited after the agent already concluded).
    // The agent's explicit SOLVED/UNSOLVED is what matters for job disposition;
    // provider health only matters when it PREVENTED a conclusion.
    const statusMarker = extractStatus(result.lastAssistantText);
    if (statusMarker === "SOLVED") {
        const flag =
            extractFlag(result.lastAssistantText) ??
            extractFlagFromSolutionMd(workspace);
        return { kind: "SOLVED", flag, summary: result.lastAssistantText };
    }
    if (statusMarker === "UNSOLVED") {
        // The agent finished and reported: not solved. That is recoverable by
        // definition — "not solved is not failure".
        if (attempts >= maxAttempts) {
            return {
                kind: "BLOCKED",
                summary: result.lastAssistantText,
                reason: `attempt limit reached (${maxAttempts})`,
            };
        }
        return {
            kind: "CONTINUE",
            summary: result.lastAssistantText,
            reason: "agent reported UNSOLVED",
        };
    }

    // 3. Provider transport error reported by the agent itself (pi: final
    // message with stopReason=error). Split by recoverability:
    //    - TRANSIENT (5xx, cache_only_cold, overloaded, network blips): the free
    //      tier throws these constantly; retrying the run fixes them. CONTINUE.
    //    - PERMANENT (auth, quota, billing): no amount of retrying helps. FATAL.
    if (result.providerError) {
        const kind = transportErrorKind(result.providerError);
        if (kind === "transient") {
            if (attempts >= maxAttempts) {
                return {
                    kind: "BLOCKED",
                    summary: result.providerError,
                    reason: `attempt limit reached (${maxAttempts}) after transient provider errors`,
                };
            }
            return {
                kind: "CONTINUE",
                summary: result.providerError,
                reason: `transient provider error (${labelTransportError(result.providerError)}) — retry`,
            };
        }
        return {
            kind: "FATAL",
            summary: result.providerError,
            reason: `provider error: ${labelTransportError(result.providerError)}`,
        };
    }

    // Did the agent complete a normal run? (clean exit + a final message)
    const completedNormally =
        result.exitCode === 0 &&
        !result.killed &&
        result.lastAssistantText.trim() !== "";

    if (completedNormally) {
        // 3b. Normal completion: the agent finished its message. Fatal only if it
        // explicitly reports being unable to continue due to infrastructure.
        for (const p of AGENT_REPORTED_FATAL) {
            const m = p.re.exec(result.lastAssistantText);
            if (m) {
                const ctx = result.lastAssistantText
                    .slice(Math.max(0, m.index - 120), m.index + 220)
                    .trim();
                return {
                    kind: "FATAL",
                    summary: ctx,
                    reason: `agent reported ${p.label}`,
                };
            }
        }
    } else {
        // 3a. Abnormal end: scan stderr and the END of the raw stream for fatal
        // transport patterns. Transient errors that pi auto-recovered mid-run do
        // NOT appear here because the run would have completed normally.
        const endOfRaw = result.rawTail.slice(-4096);
        for (const h of [
            result.stderrTail,
            endOfRaw,
            result.transcriptTail.slice(-2048),
        ]) {
            if (!h) continue;
            for (const p of FATAL_PATTERNS) {
                const m = p.re.exec(h);
                if (m) {
                    const ctx = h
                        .slice(Math.max(0, m.index - 120), m.index + 220)
                        .trim();
                    return {
                        kind: "FATAL",
                        summary: ctx,
                        reason: `fatal pattern: ${p.label}`,
                    };
                }
            }
        }
    }

    // 4. solved? (SOLVED was already handled in step 2; here only UNSOLVED or
    // no marker remain)
    if (statusMarker !== "UNSOLVED") {
        // No STATUS marker: check SOLUTION.md as backup, else treat as unsolved→continue
        const solMd = readSolutionMd(workspace);
        if (solMd?.status === "SOLVED") {
            return { kind: "SOLVED", flag: solMd.flag, summary: solMd.summary };
        }
    }

    // 5. no STATUS marker at all → CONTINUE, unless attempts exhausted → BLOCKED
    if (attempts >= maxAttempts) {
        return {
            kind: "BLOCKED",
            summary: result.lastAssistantText || result.stderrTail,
            reason: `attempt limit reached (${maxAttempts})`,
        };
    }
    return {
        kind: "CONTINUE",
        summary: result.lastAssistantText || "(agent produced no final text)",
        reason: completedNormally
            ? "run completed without SOLVED marker; treat as recoverable"
            : `abnormal end (exit=${result.exitCode}, killed=${result.killed}${result.killReason ? `, reason=${result.killReason}` : ""}); treat as recoverable`,
    };
}

/** Classify a provider transport error string for the report. */
function labelTransportError(msg: string): string {
    if (
        /\b40[13]\b|unauthorized|forbidden|invalid api[ _-]?key|auth/i.test(msg)
    )
        return "auth failure";
    if (/\b429\b|rate[ _-]?limit/i.test(msg)) return "rate limit";
    if (/quota|billing|payment|credit|balance/i.test(msg))
        return "quota/billing exhausted";
    if (/\b5\d\d\b|server error|overloaded|capacity/i.test(msg))
        return "provider unavailable";
    if (/cache_only_cold|cache-only admission/i.test(msg))
        return "provider cold-cache";
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(msg))
        return "network failure";
    return "provider transport error";
}

/** Is a provider transport error retryable by simply re-running? Transient
 * free-tier conditions (5xx, cold cache admission, overload, network blips)
 * resolve on retry. Auth/quota/billing are permanent. */
function transportErrorKind(msg: string): "transient" | "permanent" {
    // Permanent: credentials and money.
    if (
        /\b40[13]\b|unauthorized|forbidden|invalid api[ _-]?key|auth/i.test(msg)
    )
        return "permanent";
    if (/quota|billing|payment required|insufficient|credit|balance/i.test(msg))
        return "permanent";
    // 429 rate limit: transient in the "wait and retry" sense, but the
    // dispatcher's next rotation tick is the retry — treat as transient.
    if (/\b429\b|rate[ _-]?limit/i.test(msg)) return "transient";
    // Everything else: 5xx, cache_only_cold, overloaded, network — transient.
    return "transient";
}

export function extractStatus(text: string): "SOLVED" | "UNSOLVED" | null {
    if (!text) return null;
    const m = text.match(/^\s*STATUS:\s*(SOLVED|UNSOLVED)\s*$/im);
    if (!m) return null;
    return m[1].toUpperCase() as "SOLVED" | "UNSOLVED";
}

/** Extract the flag from "Flag: ..." lines in the final report or SOLUTION.md. */
export function extractFlag(text: string): string | null {
    if (!text) return null;
    // "Flag: X" / "flag = X" / "**Flag:** `X`", anywhere in the text.
    // Requires a : or = right after "flag" (so "flag format: ..." prose won't match),
    // and "flag{...}" without a separator won't match either.
    const m = text.match(
        /\bflag\s*(?:\*\*|__)?\s*[:=]\s*(?:\*\*|__)?\s*`?([^\n`]+?)`?\s*(?:\n|$)/i,
    );
    if (!m?.[1]) return null;
    let value = m[1].trim();
    // Strip trailing sentence punctuation
    value = value.replace(/[.,;]+$/, "").trim();
    if (!value || value.length > 500) return null;
    // If the value contains spaces, the flag is usually the first token
    // (e.g. "Flag: CTF{abc} verified against the README"). Only take the first
    // token when it actually looks like a flag (contains braces).
    if (value.includes(" ")) {
        const first = value.split(/\s+/)[0];
        if (/[{]/.test(first)) return first;
    }
    return value;
}

interface SolutionMd {
    status: "SOLVED" | "UNSOLVED" | null;
    flag: string | null;
    summary: string;
}

function readSolutionMd(workspace: string): SolutionMd | null {
    try {
        const text = fs.readFileSync(
            path.join(workspace, "SOLUTION.md"),
            "utf8",
        );
        return parseSolutionMd(text);
    } catch {
        return null;
    }
}

function parseSolutionMd(text: string): SolutionMd | null {
    if (!text.trim()) return null;
    const statusM = text.match(/(?:^|\n)\s*Status:\s*(SOLVED|UNSOLVED)/i);
    const flagM = text.match(/(?:^|\n)\s*Flag:\s*([^\n]+)/i);
    return {
        status: statusM
            ? (statusM[1].toUpperCase() as "SOLVED" | "UNSOLVED")
            : null,
        flag: flagM ? flagM[1].trim() : null,
        summary: text.trim(),
    };
}

function extractFlagFromSolutionMd(workspace: string): string | null {
    const md = readSolutionMd(workspace);
    return md?.flag ?? null;
}
