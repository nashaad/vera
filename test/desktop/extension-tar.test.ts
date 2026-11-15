import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { MAX_PACKAGE_ENTRIES, MAX_PACKAGE_FILE_BYTES, MAX_PACKAGE_TOTAL_BYTES } from "../../clients/desktop/src/extensions/limits.ts";
import { ExtensionRefusal } from "../../clients/desktop/src/extension-install/refusal.ts";
import { readTar, type TarLimits } from "../../clients/desktop/src/extension-install/tar.ts";
import { packageEntries } from "../../clients/desktop/src/extension-install/unpack.ts";
import { tarBytes, tarGzBytes, type TarItem } from "./extension-fixtures.ts";
import { removeScratchDirectories } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

const LIMITS: TarLimits = { entries: 8, fileBytes: 1024, totalBytes: 2048, pathChars: 60 };

function refusal(items: readonly TarItem[], limits: TarLimits = LIMITS): string {
    try {
        readTar(tarBytes(items), limits);
    } catch (error) {
        if (error instanceof ExtensionRefusal) return error.message;
        throw error;
    }
    return "";
}

test("@core files and folders at the archive root are read in order", () => {
    const entries = readTar(tarBytes([{ name: "vera.desktop.json", data: "{}" }, { name: "themes/", type: "5" }, { name: "themes/a.json", data: "x".repeat(700) }]), LIMITS);
    expect(entries.map((entry) => [entry.path, entry.kind, entry.data.length])).toEqual([
        ["vera.desktop.json", "file", 2],
        ["themes", "directory", 0],
        ["themes/a.json", "file", 700],
    ]);
    expect(entries[2]?.data.toString()).toBe("x".repeat(700));
});

test("a leading ./ and the root folder entry are dropped, and a ustar prefix is joined", () => {
    const entries = readTar(tarBytes([{ name: "./", type: "5" }, { name: "./a.json", data: "1" }, { name: "b.json", prefix: "deep/er", data: "2" }]), LIMITS);
    expect(entries.map((entry) => entry.path)).toEqual(["a.json", "deep/er/b.json"]);
});

test("@core links, devices and extended headers are refused", () => {
    for (const type of ["1", "2", "3", "4", "6", "7", "x", "g", "L", "K"]) {
        expect(refusal([{ name: "thing", type }])).toContain("is not a plain file or folder");
    }
});

test("@core an absolute path, a .. segment, a drive and control characters are refused", () => {
    for (const name of ["/etc/passwd", "../outside.json", "a/../../outside.json", "a/..", "C:evil", "a\\b.json", "a\u0007b"]) {
        expect(refusal([{ name, data: "x" }])).toContain("leaves its folder or is not plain text");
    }
    expect(refusal([{ name: "ok.json", prefix: "../up", data: "x" }])).toContain("leaves its folder");
});

test("a path longer than the cap is refused", () => {
    expect(refusal([{ name: "a".repeat(61), data: "x" }])).toContain("leaves its folder or is not plain text");
});

test("@core caps: entry count, one file, and the total", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `f${index}.json`, data: "x" }));
    expect(refusal(many)).toBe("The package holds more than 8 entries.");
    expect(refusal([{ name: "big.json", data: "x".repeat(1025) }])).toContain('"big.json" is larger than');
    expect(refusal([{ name: "a.json", data: "x".repeat(1000) }, { name: "b.json", data: "x".repeat(1000) }, { name: "c.json", data: "x".repeat(100) }])).toContain("The package unpacks to more than");
});

test("a size field larger than the data is refused instead of read past the end", () => {
    const roomy = { ...LIMITS, fileBytes: 1_000_000, totalBytes: 1_000_000 };
    expect(refusal([{ name: "a.json", data: "x", size: 5000 }], roomy)).toBe("The package is not a gzip tar file.");
});

test("a base-256 size and a folder with a size are refused", () => {
    const archive = tarBytes([{ name: "a.json", data: "x" }]);
    archive[124] = 0x80;
    expect(() => readTar(archive, LIMITS)).toThrow();
    expect(refusal([{ name: "d/", type: "5", size: 5 }])).toBe("The package is not a gzip tar file.");
});

test("a repeated path is refused, including one that differs only in case", () => {
    expect(refusal([{ name: "a.json", data: "1" }, { name: "a.json", data: "2" }])).toBe('The package lists "a.json" twice.');
    expect(refusal([{ name: "A.json", data: "1" }, { name: "a.JSON", data: "2" }])).toContain("twice");
});

test("a header with a bad checksum is refused", () => {
    const archive = tarBytes([{ name: "a.json", data: "x" }]);
    archive[0] = (archive[0] ?? 0) ^ 0x01;
    expect(() => readTar(archive, LIMITS)).toThrow("The package is not a gzip tar file.");
});

test("an archive with nothing in it reads as no entries", () => {
    expect(readTar(tarBytes([]), LIMITS)).toEqual([]);
});

test("@core packageEntries refuses what is not gzip, and an archive that unpacks past the cap before reading it whole", () => {
    expect(() => packageEntries(Buffer.from("not a package"))).toThrow("The package is not a gzip tar file.");
    const bomb = gzipSync(Buffer.alloc(MAX_PACKAGE_TOTAL_BYTES + MAX_PACKAGE_ENTRIES * 1024 + 4096));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => packageEntries(bomb)).toThrow("The package unpacks to more than 16 MiB.");
});

test("packageEntries applies the package limits", () => {
    expect(packageEntries(tarGzBytes([{ name: "a.json", data: "1" }])).map((entry) => entry.path)).toEqual(["a.json"]);
    const big = tarGzBytes([{ name: "big.bin", data: Buffer.alloc(MAX_PACKAGE_FILE_BYTES + 1) }]);
    expect(() => packageEntries(big)).toThrow("is larger than 4 MiB");
});
