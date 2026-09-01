import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    FACTORY_HELLO_SESSION_ID,
    synthesizeFactoryHome,
} from "../../scripts/synthesize-factory-home.ts";
import { unrecognisedHomeEntries } from "../../src/profile-paths.ts";

test("the factory home is a single home with no live secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-factory-"));
    const home = join(root, ".vera");
    try {
        synthesizeFactoryHome(home);
        expect(existsSync(join(home, "profiles"))).toBe(false);
        expect(existsSync(join(home, "runtime", "host.json"))).toBe(false);
        expect(existsSync(join(home, "runtime", "host.sock"))).toBe(false);
        expect(existsSync(join(home, "machine", "auth.json"))).toBe(false);
        expect(unrecognisedHomeEntries(root)).toEqual([]);
        const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
        expect(config.model).toBe("faux/test");
        expect(config.experimental.inbox).toBe(false);
        expect(config.extensions).toEqual([]);
        expect(existsSync(
            join(home, "runtime", "sessions", `${FACTORY_HELLO_SESSION_ID}.jsonl`),
        )).toBe(true);
        expect(readFileSync(join(home, "memory", "welcome.md"), "utf8"))
            .toContain("synthesized");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
