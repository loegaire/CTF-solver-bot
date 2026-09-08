/**
 * Solving prompts. The STATUS protocol makes the agent's outcome machine-readable:
 * every run must end with exactly one line "STATUS: SOLVED" or "STATUS: UNSOLVED".
 */

export function buildInitialPrompt(challengeName: string): string {
  return `Analyze and solve this CTF challenge ("${challengeName}").

Read the README first (if present) and inspect all supplied files in this directory.
This directory is your persistent workspace: everything you write here is preserved
across runs, so keep notes, scripts, and intermediate artifacts here.

REPO-README.md in this directory is the challenge repository's top-level README,
kept in sync by the dispatcher. It is the central source of competition-wide
information: instance URLs, account credentials, login tokens, and any other
shared details. Read it FIRST, use anything relevant (credentials, instance
links, connection details), and re-read it if a step fails in a way that fresh
credentials or a new instance might fix.

USE THE AVAILABLE TOOLS AND SKILLS. If specialized tools are configured (MCP
tools like radare2 or playwright, or CTF skills), prefer them over manual work —
e.g. use the reverse-engineering MCP tools for binary analysis instead of
raw objdump/grep. They are much more capable.

MAINTAIN WRITEUP.md — your working scratch pad, preserved across runs:

## Facts
Established, verified truths about the challenge (with how you verified each).
## Hypotheses
Ideas not yet confirmed. Mark each CONFIRMED or REFUTED as you learn more,
and move confirmed ones into Facts. Never re-test a refuted hypothesis.
## Testing plan
Your current step-by-step approach, updated as you go. Keep it focused on
the next concrete steps.

Update WRITEUP.md whenever you establish a fact, confirm/refute a hypothesis,
or change approach — not just at the end. This is how your progress is
visible to the outside world, and it is how you avoid redoing work.

Use the available tools and perform whatever analysis, reversing, exploitation,
scripting, decoding, or testing is necessary. When you find a candidate flag,
verify it if the challenge allows (run the binary, replay the exploit, check the
format against the README).

Do not stop merely because the challenge has not yet been solved. A lack of
progress is not a reason to terminate. Continue working until either:
1. the challenge is solved, or
2. an external/fatal error prevents further work.

When you finish this run, ALWAYS end your final message with exactly one of:

STATUS: SOLVED
STATUS: UNSOLVED

If (and only if) you solved it, also write a SOLUTION.md file in this directory:

# Solution
Status: SOLVED
Flag: <the flag>
## Summary
<concise explanation of the solution>
## Artifacts
<list of useful scripts/files you produced>

In your final message report: solved or unsolved, the flag if found, a concise
solution, important discoveries, and useful artifacts.

Begin now.`;
}

const NUDGES = [
  "Take stock: list what you have established, what remains unverified, and which of the unexplored paths looks most promising. Then pursue that path concretely.",
  "Try a completely different category of approach (e.g. static -> dynamic, brute force -> clever, high-level -> low-level, or vice versa).",
  "Question your earlier assumptions: re-derive each one from the actual files instead of trusting memory. One wrong assumption can block everything.",
  "Look for easier wins you may have skipped: weak encodings, hardcoded secrets, metadata, debug leftovers, unintended input paths, or known weak primitives.",
  "Write a concrete step-by-step attack plan in a notes file, then execute it one step at a time, verifying each step before moving to the next.",
  "Reduce the problem: build a minimal reproducer of the mechanism you suspect, confirm it behaves as you think, then scale it back up to the real challenge.",
];

export function buildContinuationPrompt(attempts: number): string {
  const nudge = NUDGES[(attempts - 1 + NUDGES.length) % NUDGES.length];
  return `Continue working on the challenge. You have not solved it yet (this is attempt ${attempts}).

Do not stop because the previous approach failed — that is only one approach
failing, not the job. Your workspace and previous work are preserved; build on
them instead of starting from scratch. Re-read your WRITEUP.md first to
recall established facts and refuted hypotheses — do not redo work you
already did. Also re-read REPO-README.md — it may have been updated with new
credentials, instances, or competition-wide information since your last run.

${nudge}

Update WRITEUP.md as you go: add new facts, mark hypotheses CONFIRMED or
REFUTED, and keep the testing plan current.

Keep working until the challenge is solved or an external/fatal error prevents
further work. As before, you MUST end your final message with exactly one of:

STATUS: SOLVED
STATUS: UNSOLVED

If you have now solved it, also write SOLUTION.md as previously instructed
(Status, Flag, Summary, Artifacts).`;
}

/** Persistent workspace instructions, staged as AGENTS.md next to the challenge files. */
export function buildWorkspaceAgentsMd(): string {
  return `# CTF challenge workspace

You are solving a CTF challenge in this directory. This workspace is preserved
between runs: your notes, scripts, and artifacts persist, and so do the challenge
files.

## Tools
- Check your available tools before starting — specialized MCP tools (radare2,
  playwright, ...) and CTF skills may be configured and are usually far more
effective than manual analysis. Prefer them.

## REPO-README.md — repo-wide info (credentials, instances)
- REPO-README.md is the repository's top-level README, synced by the dispatcher
  on every update. It may contain instance URLs, account credentials, login
  tokens, and other competition-wide information.
- Read it first; use anything relevant. Re-read it when a connection or
  authentication step fails — credentials may have been rotated.

## WRITEUP.md — required scratch pad
Maintain WRITEUP.md in this directory at all times with three sections:

## Facts
- Established truths about the challenge, each with how you verified it.
## Hypotheses
- Unconfirmed ideas, each marked CONFIRMED or REFUTED once tested. Move
  confirmed ones to Facts. Never re-test a refuted hypothesis.
## Testing plan
- Current step-by-step approach; update as you learn.

Update it whenever you establish a fact, confirm/refute a hypothesis, or change
approach — not just at the end of a run.

## Completion rules
- Keep working until the challenge is solved or a fatal error stops you. Never
  give up early; "no progress yet" is not a stopping reason.
- Every run must end its final message with exactly one line:
  STATUS: SOLVED or STATUS: UNSOLVED.
- When solved, write SOLUTION.md containing Status, Flag, Summary, Artifacts
  (see task.txt for the exact format).
- task.txt holds your original instructions; re-read it if you are unsure.
- Write working artifacts to files so later runs can reuse them.
`;
}
