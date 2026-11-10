import { expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";

import { editDiffPresentation } from "../../src/tools/diff-presentation.ts";
import type { ToolPresentation } from "../../src/model/types.ts";

function previousPresentation(
    path: string,
    before: string,
    after: string,
    stashDirectory?: string,
): ToolPresentation {
    const patch = createTwoFilesPatch(path, path, before, after, "", "", { context: 3 });
    if (Buffer.byteLength(patch) <= 64 * 1024 && patch.split("\n").length <= 400) {
        return { kind: "unified_diff", path, patch };
    }
    let added = 0;
    let removed = 0;
    for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    const beforeBytes = Buffer.byteLength(before);
    const afterBytes = Buffer.byteLength(after);
    const lost = beforeBytes === 0 || afterBytes >= beforeBytes
        ? 0
        : Math.round(((beforeBytes - afterBytes) / beforeBytes) * 100);
    const formatBytes = (bytes: number) => bytes < 1024
        ? `${bytes} B`
        : `${(bytes / 1024).toFixed(1)} KiB`;
    const counts = `-${removed.toLocaleString()} +${added.toLocaleString()} lines (${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)})`;
    const magnitude = lost >= 1 ? `${counts}, ${lost}% of file removed` : counts;
    const stashPointer = stashDirectory !== undefined && lost >= 50
        ? `; pre-image saved in ${stashDirectory}`
        : "";
    return { kind: "tool_notice", text: `Diff too large to show inline for ${path}: ${magnitude}${stashPointer}.` };
}

function compare(path: string, before: string, after: string, stash?: string): void {
    expect(editDiffPresentation(path, before, after, stash))
        .toEqual(previousPresentation(path, before, after, stash));
}

test("patches and notices match the previous presentation at both limits", () => {
    const pairs = [
        ["", ""],
        ["one\ntwo\n", "one\nTWO\n"],
        ["old", "new"],
        ["old\r\n", "new\r\n"],
        ["x".repeat(65_500), "y".repeat(20)],
        ["x".repeat(65_536), "y".repeat(65_536)],
    ];
    for (const length of [193, 197, 198, 199, 200, 201, 400, 401, 500]) {
        pairs.push([
            Array.from({ length }, (_, index) => `old ${index}`).join("\n"),
            Array.from({ length }, (_, index) => `new ${index}`).join("\n"),
        ]);
    }
    for (const [before, after] of pairs) {
        compare("voyage.txt", before!, after!, "/stash/crew");
    }
});

test("@core patch and notice boundaries are unchanged at exactly 400 lines and 64 KiB", () => {
    for (const target of [399, 400, 401]) {
        const after = Array.from({ length: target - 6 }, (_, index) => `crow ${index}`).join("\n") + "\n";
        const patch = createTwoFilesPatch("f", "f", "", after, "", "", { context: 3 });
        expect(patch.split("\n")).toHaveLength(target);
        compare("f", "", after);
    }
    const example = createTwoFilesPatch("f", "f", "", "x", "", "", { context: 3 });
    const overhead = Buffer.byteLength(example) - 1;
    for (const target of [65_535, 65_536, 65_537]) {
        const after = "x".repeat(target - overhead);
        const patch = createTwoFilesPatch("f", "f", "", after, "", "", { context: 3 });
        expect(Buffer.byteLength(patch)).toBe(target);
        compare("f", "", after);
    }
});

test("disjoint replacements preserve marker filtering, filenames and newline forms", () => {
    const paths = ["crow.txt", "crow\n+one\n-two\n+++ignored\n---ignored", "café ☀.txt"];
    for (const ending of ["\n", "\r\n", ""]) {
        const before = Array.from({ length: 420 }, (_, index) =>
            index % 4 === 0 ? `--old ${index}` : `old ${index}`
        ).join("\r\n") + ending;
        const after = Array.from({ length: 420 }, (_, index) =>
            index % 3 === 0 ? `++new ${index}` : `new ${index}`
        ).join("\n") + ending;
        for (const path of paths) compare(path, before, after, "/stash/crew");
    }
});

test("large shared, repeated, moved and destructive changes retain the original result", () => {
    const shared = Array.from({ length: 5000 }, (_, index) => `cargo ${index}`);
    const altered = [...shared];
    altered.splice(1400, 550, ...Array.from({ length: 530 }, (_, index) => `new cargo ${index}`));
    compare("crow.txt", shared.join("\n"), altered.join("\n"));
    compare("crow.txt", `${shared.join("\n")}\n`, "deck\n", "/stash/crew");
    const repeated = Array.from({ length: 700 }, (_, index) => ["--old", "++new", "crow", "deck"][index % 4]!);
    compare("crow.txt", repeated.join("\n"), [...repeated.slice(230), ...repeated.slice(0, 230)].join("\n"));
});

test("independent changes retain counts with shared prefixes, suffixes and ambiguous repeated lines", () => {
    const oldLines = Array.from({ length: 230 }, (_, index) => index % 7 === 0 ? `--old ${index}` : `old ${index}`);
    const newLines = Array.from({ length: 230 }, (_, index) => index % 9 === 0 ? `++new ${index}` : `new ${index}`);
    for (const ending of ["\n", "\r\n"]) {
        for (const prefix of ["", `forecastle${ending}deck${ending}`]) {
            for (const suffix of ["", `${ending}rigging${ending}crow`, `${ending}old 4${ending}++new 9`]) {
                compare("crow.txt", prefix + oldLines.join(ending) + suffix, prefix + newLines.join(ending) + suffix);
            }
        }
    }
    compare("crow.txt", `deck\n${"x".repeat(33_000)}\nrigging\n`, `deck\n${"y".repeat(33_000)}\nrigging\n`);
});

test("deterministic mixed line inputs match the previous presentation", () => {
    let seed = 57;
    const next = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed;
    };
    const vocabulary = ["crow", "--deck", "++sail", "", "é", "☀", "  ", "star"];
    for (let example = 0; example < 60; example += 1) {
        const make = (count: number) => Array.from({ length: count }, () =>
            vocabulary[next() % vocabulary.length]!
        ).join(next() % 2 === 0 ? "\n" : "\r\n") + (next() % 2 === 0 ? "\n" : "");
        compare("crow.txt", make(next() % 35), make(next() % 35));
    }
});
