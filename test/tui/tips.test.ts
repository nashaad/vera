import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    launchesSinceShown,
    recordTuiTipShown,
    selectTuiTip,
    TUI_TIPS,
    type TuiTip,
    type TuiTipContext,
} from "../../clients/tui/tips.ts";
import {
    beginTuiTipLaunch,
    loadTuiTipState,
    saveTuiTipState,
} from "../../clients/tui/tips-store.ts";

const context: TuiTipContext = {
    launches: 10,
    pooledCount: 3,
    namedPoolCount: 0,
    anyVerified: false,
    inModelPicker: true,
};

function tip(id: string, overrides: Partial<TuiTip> = {}): TuiTip {
    return {
        id,
        text: () => id,
        cooldownLaunches: 0,
        isRelevant: () => true,
        ...overrides,
    };
}

test("a tip inside its cooldown is not offered again", () => {
    const pool = [tip("recent", { cooldownLaunches: 5 })];

    expect(selectTuiTip(context, { recent: 8 }, pool)).toBeUndefined();
    expect(selectTuiTip(context, { recent: 4 }, pool)?.id).toBe("recent");
});

test("an irrelevant tip is never offered, however long it has waited", () => {
    const pool = [tip("never", { isRelevant: () => false })];

    expect(selectTuiTip(context, {}, pool)).toBeUndefined();
});

test("the longest unshown wins, and unshown beats any shown", () => {
    const pool = [tip("old"), tip("older"), tip("fresh")];

    expect(selectTuiTip(context, { old: 8, older: 2, fresh: 9 }, pool)?.id)
        .toBe("older");
    // "fresh" has never been shown at all, which outranks every shown tip.
    expect(selectTuiTip(context, { old: 8, older: 2 }, pool)?.id).toBe("fresh");
});

test("a fresh pool hands out every tip once before repeating one", () => {
    const pool = [tip("a"), tip("b"), tip("c")];
    let history = {};
    const seen: string[] = [];

    for (let index = 0; index < 3; index += 1) {
        const chosen = selectTuiTip(context, history, pool)!;
        seen.push(chosen.id);
        history = recordTuiTipShown(chosen.id, history, context.launches);
    }

    expect([...seen].sort()).toEqual(["a", "b", "c"]);
});

test("a tip never shown counts as infinitely long ago", () => {
    expect(launchesSinceShown("absent", {}, 4)).toBe(Number.POSITIVE_INFINITY);
    expect(launchesSinceShown("shown", { shown: 1 }, 4)).toBe(3);
});

test("the built-in pool offers nothing about naming until something is pooled", () => {
    const empty: TuiTipContext = { ...context, pooledCount: 0 };
    const naming = TUI_TIPS.find((entry) => entry.id === "name-pool-entry")!;

    expect(naming.isRelevant(empty)).toBe(false);
    expect(naming.isRelevant({ ...context, pooledCount: 1 })).toBe(true);
    // Someone who already names their entries does not need to be told how.
    expect(naming.isRelevant({ ...context, namedPoolCount: 4 })).toBe(false);
});

test("every built-in tip renders a non-empty line", () => {
    for (const entry of TUI_TIPS) {
        expect(entry.text(context).length).toBeGreaterThan(0);
        // A chord the keymap does not know renders as an empty string, which
        // would leave "Press  to ..." on screen.
        expect(entry.text(context)).not.toContain("  ");
    }
});

test("the launch counter advances once per start and survives a reload", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-tips-")), "tips.json");

    expect(beginTuiTipLaunch(path).launches).toBe(1);
    expect(beginTuiTipLaunch(path).launches).toBe(2);

    saveTuiTipState({ launches: 2, history: { "a": 1 } }, path);
    expect(loadTuiTipState(path)).toEqual({ launches: 2, history: { "a": 1 } });
});

test("a missing or damaged tips file reads as no history", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tips-"));
    const missing = join(directory, "absent.json");
    expect(loadTuiTipState(missing)).toEqual({ launches: 0, history: {} });

    const damaged = join(directory, "damaged.json");
    Bun.write(damaged, "{ not json");
    expect(loadTuiTipState(damaged)).toEqual({ launches: 0, history: {} });
});

test("an extension tip competes in the pool on the same terms", () => {
    const extensionTip: TuiTip = {
        id: "client.tipper:welcome",
        text: () => "Try /help",
        cooldownLaunches: 3,
        isRelevant: () => true,
    };
    const pool = [...TUI_TIPS, extensionTip];
    const now: TuiTipContext = { ...context, launches: 4 };

    // Never shown beats everything shown, whoever registered it.
    const history = Object.fromEntries(
        TUI_TIPS.map((tip) => [tip.id, 4] as const),
    );
    expect(selectTuiTip(now, history, pool)?.id).toBe(extensionTip.id);

    // And its own cooldown holds it back once it has been shown.
    expect(
        selectTuiTip(now, { ...history, [extensionTip.id]: 4 }, pool),
    ).toBeUndefined();
});
