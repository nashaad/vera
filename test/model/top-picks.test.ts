import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTopPicks } from "../../src/model/top-picks.ts";

test("the shipped top-picks file parses and every pick is whole", () => {
    const picks = loadTopPicks();

    expect(picks.length).toBeGreaterThan(0);
    for (const pick of picks) {
        expect(pick.provider.length).toBeGreaterThan(0);
        expect(pick.model.length).toBeGreaterThan(0);
        expect(pick.label.length).toBeGreaterThan(0);
    }
});

test("a damaged top-picks file is an error, not an empty list", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-top-picks-")), "p.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        top_picks: [{ provider: "openrouter" }],
    }));

    expect(() => loadTopPicks(path)).toThrow("Invalid top-picks catalog");
});
