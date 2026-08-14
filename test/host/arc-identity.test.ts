import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readArcNodeId, readArcToken } from "../../src/host/arc-identity.ts";

function withConfig(body: string, run: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "vera-arc-identity-"));
    const path = join(dir, "config.toml");
    writeFileSync(path, body);
    try {
        run(path);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("arc identity", () => {
    test("the node id is read from arc's config file", () => {
        withConfig(
            [
                "# arc local identity",
                'node_id = "node-a"',
                'role = "developer"',
            ].join("\n"),
            (path) => {
                expect(readArcNodeId(path)).toBe("node-a");
            },
        );
    });

    test("a missing file reads as no identity, not a failure", () => {
        expect(readArcNodeId("/nonexistent/arc/config.toml")).toBeNull();
    });

    test("a commented-out or empty node id reads as no identity", () => {
        withConfig('# node_id = "ghost"\nnode_id = ""\n', (path) => {
            expect(readArcNodeId(path)).toBeNull();
        });
    });

    test("a trailing comment after the value does not join the id", () => {
        withConfig('node_id = "node-b" # this machine\n', (path) => {
            expect(readArcNodeId(path)).toBe("node-b");
        });
    });

    test("the bearer token is read from arc's config file", () => {
        withConfig(
            [
                'node_id = "node-a"',
                'token = "tok-123" # keep private',
                'server_url = "https://arc.example/"',
            ].join("\n"),
            (path) => {
                expect(readArcToken(path)).toBe("tok-123");
            },
        );
    });

    test("a missing file or absent token reads as no token", () => {
        expect(readArcToken("/nonexistent/arc/config.toml")).toBeNull();
        withConfig('node_id = "node-a"\ntoken = ""\n', (path) => {
            expect(readArcToken(path)).toBeNull();
        });
    });
});
