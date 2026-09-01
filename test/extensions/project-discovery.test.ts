import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverProjectExtensionConfigs } from "../../src/extensions/discovery.ts";

test("a workspace with no .vera/extensions yields no project configs", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-project-ext-empty-"));
    try {
        expect(discoverProjectExtensionConfigs(root)).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("project extension discovery reads only that workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-project-ext-"));
    const projectA = join(root, "a");
    const projectB = join(root, "b");
    try {
        const dirA = join(projectA, ".vera", "extensions", "acme.a");
        mkdirSync(dirA, { recursive: true });
        writeFileSync(join(dirA, "vera.extension.json"), JSON.stringify({
            id: "acme.a",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "extension.ts",
            capabilities: [],
        }));
        writeFileSync(join(dirA, "extension.ts"), "export function activate() {}\n");
        mkdirSync(join(projectB, ".vera", "extensions"), { recursive: true });

        const foundA = discoverProjectExtensionConfigs(projectA);
        expect(foundA).toHaveLength(1);
        expect(foundA[0]?.path).toContain(`${join("a", ".vera", "extensions", "acme.a")}`);
        expect(discoverProjectExtensionConfigs(projectB)).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
