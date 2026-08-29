import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRegularFileTextSync } from
    "../../src/store/regular-file.ts";

test("regular file reads enforce their byte limit", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-regular-read-"));
    const path = join(root, "value.txt");
    try {
        writeFileSync(path, "value");
        expect(readRegularFileTextSync(path, 5)).toBe("value");
        expect(() => readRegularFileTextSync(path, 4)).toThrow(
            "File exceeds 4 bytes",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
