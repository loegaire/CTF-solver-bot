/**
 * Discovery tests: recursive README-anchored grouping, SOLVED.txt marking,
 * exclusions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    groupChallenges,
    isMarkedSolved,
    parseSolvedFile,
} from "../src/sources/source.js";
import type { RawFile } from "../src/types.js";

function raw(path: string, size = 10): RawFile {
    return { path, size, mode: "100644", sha: `sha-${path}` };
}

test("flat layout: each top-level dir with README is a challenge", () => {
    const files = [
        raw("neon/README.md"),
        raw("neon/binary"),
        raw("ghost/README.md"),
        raw("ghost/files.zip"),
    ];
    const refs = groupChallenges("", files, "rev1");
    assert.deepEqual(refs.map((r) => r.path).sort(), ["ghost", "neon"]);
});

test("categorized layout challenges/<cat>/<name>/ — categories are traversed, names are challenges", () => {
    const files = [
        raw("challenges/web/blind/README.md"),
        raw("challenges/web/blind/app.py"),
        raw("challenges/pwn/heap/README.md"),
        raw("challenges/pwn/heap/binary"),
    ];
    const refs = groupChallenges("", files, "rev1");
    assert.deepEqual(refs.map((r) => r.path).sort(), [
        "challenges/pwn/heap",
        "challenges/web/blind",
    ]);
    // outermost-README rule: a README deep inside files/ does NOT split a challenge
    const withNested = [
        ...files,
        raw("challenges/web/blind/files/nested/README.md"),
    ];
    const refs2 = groupChallenges("", withNested, "rev1");
    assert.deepEqual(
        refs2.map((r) => r.path),
        ["challenges/pwn/heap", "challenges/web/blind"],
    );
});

test("challenge files with no README anywhere: deepest file-bearing dir is the challenge", () => {
    const files = [
        raw("somewhere/deep/chall/prog.c"),
        raw("somewhere/deep/chall/data.bin"),
    ];
    const refs = groupChallenges("", files, "rev1");
    assert.deepEqual(
        refs.map((r) => r.path),
        ["somewhere/deep/chall"],
    );
});

test("outermost candidate wins when multiple READMEs exist on one path", () => {
    // challenge README at <name>/README.md; nested README inside files/ belongs to the same challenge
    const files = [
        raw("neon/README.md"),
        raw("neon/files/README.md"),
        raw("neon/files/x.bin"),
    ];
    const refs = groupChallenges("", files, "rev1");
    assert.deepEqual(
        refs.map((r) => r.path),
        ["neon"],
    );
    const neon = refs[0];
    assert.ok(neon.files.some((f) => f.name === "files/x.bin"));
});

test("excluded names are skipped at ANY depth (writeups anywhere is not a challenge)", () => {
    const files = [
        raw("writeups/x.md"),
        raw("challenges/web/blind/README.md"),
        raw("challenges/writeups/old/README.md"),
        raw("real/README.md"),
    ];
    const refs = groupChallenges("", files, "rev1", ["writeups"]);
    assert.deepEqual(refs.map((r) => r.path).sort(), [
        "challenges/web/blind",
        "real",
    ]);
});

test("hidden dirs are never challenges", () => {
    const files = [
        raw(".git/config"),
        raw(".github/workflows/ci.yml"),
        raw("ok/README.md"),
    ];
    const refs = groupChallenges("", files, "rev1");
    assert.deepEqual(
        refs.map((r) => r.path),
        ["ok"],
    );
});

test("pinned root scopes discovery", () => {
    const files = [
        raw("challenges/web/blind/README.md"),
        raw("other-thing/README.md"),
    ];
    const refs = groupChallenges("challenges", files, "rev1");
    assert.deepEqual(
        refs.map((r) => r.path),
        ["challenges/web/blind"],
    );
});

test("SOLVED.txt: full path, category-qualified, and bare name all match", () => {
    const ref = { path: "challenges/web/blind", name: "web/blind" };
    assert.ok(isMarkedSolved(ref, ["challenges/web/blind"]));
    assert.ok(isMarkedSolved(ref, ["web/blind"]));
    assert.ok(isMarkedSolved(ref, ["blind"]));
    assert.ok(!isMarkedSolved(ref, ["other"]));
    // fuzzy suffix matching: "web/blind" matches a pinned-path challenge
    assert.ok(isMarkedSolved({ path: "blind", name: "blind" }, ["web/blind"]));
});

test("parseSolvedFile: lines, comments, blanks", () => {
    const out = parseSolvedFile("# comment\n\nblind\nchallenges/web/x\n");
    assert.deepEqual(out, ["blind", "challenges/web/x"]);
});

test("mixed: root challenges + categorized challenges discovered together", () => {
    const files = [
        raw("neon/README.md"),
        raw("challenges/web/blind/README.md"),
        raw("challenges/pwn/heap/README.md"),
        raw("README.md"), // repo root README — not a challenge (loose file)
        raw("writeups/z.md"),
    ];
    const refs = groupChallenges("", files, "rev1", ["writeups"]);
    assert.deepEqual(refs.map((r) => r.path).sort(), [
        "challenges/pwn/heap",
        "challenges/web/blind",
        "neon",
    ]);
});
