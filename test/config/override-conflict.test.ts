import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    overridePatchDefaults,
    updateVeraConfigDefaults,
} from "../../src/config.ts";
import {
    overrideConflict,
    overrideRows,
    OVERRIDE_KEYS,
    type ConfiguredOverrides,
    type OverrideKey,
} from "../../src/engine/override-rows.ts";
import { OVERRIDE_VALUE_ROWS } from "../../clients/tui/settings-picker-starters.ts";

const CAPACITY = 200_000;

type Pick = readonly [OverrideKey, number | string | null];

/** The pane's own reading of an option, as the selection builder does it. */
function pickValue(key: OverrideKey, option: string): number | string | null {
    if (option === "default" || option === "auto") return null;
    return key === "toolResultAgingLevel" ? option : Number(option);
}

function optionsFor(key: OverrideKey): readonly string[] {
    const row = OVERRIDE_VALUE_ROWS.find((candidate) => candidate.key === key);
    if (row === undefined) {
        throw new Error(`no pane row for ${key}`);
    }
    return row.options.map((option) => option.value);
}

function configuredWith(pick: Pick): ConfiguredOverrides {
    const [key, value] = pick;
    return value === null ? {} : { [key]: value };
}

/** Which pick a config file turned down, or undefined when every one landed. */
function refusedByWrite(picks: readonly Pick[]): number | undefined {
    const directory = mkdtempSync(join(tmpdir(), "vera-override-"));
    const path = join(directory, "config.json");
    try {
        for (const [at, [key, value]] of picks.entries()) {
            try {
                updateVeraConfigDefaults(
                    overridePatchDefaults({ [key]: value }),
                    { path },
                );
            } catch {
                return at;
            }
        }
        return undefined;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function refusedByPane(
    held: ConfiguredOverrides,
    pick: Pick,
): boolean {
    return overrideConflict(overrideRows(held, CAPACITY), { [pick[0]]: pick[1] })
        !== undefined;
}

/**
 * The pane turns a pick down exactly when the file it would leave does not
 * load. Every pair the pane can reach is walked, so a rule added to a parser
 * without a matching comparison in the pane fails this rather than bricking
 * the config the pane exists to edit.
 */
function agreesWithTheParsers(held: OverrideKey, picked: OverrideKey): void {
    for (const heldOption of optionsFor(held)) {
        const holding: Pick = [held, pickValue(held, heldOption)];
        const heldRefused = refusedByPane({}, holding);
        expect({ heldOption, refused: heldRefused }).toEqual({
            heldOption,
            refused: refusedByWrite([holding]) === 0,
        });
        if (heldRefused) {
            // The pane never leaves a config in this state, so nothing can be
            // picked on top of it.
            continue;
        }
        for (const pickedOption of optionsFor(picked)) {
            const pick: Pick = [picked, pickValue(picked, pickedOption)];
            expect({
                heldOption,
                pickedOption,
                refused: refusedByPane(configuredWith(holding), pick),
            }).toEqual({
                heldOption,
                pickedOption,
                refused: refusedByWrite([holding, pick]) === 1,
            });
        }
    }
}

test("every lever's own options land on an untouched config", () => {
    for (const key of OVERRIDE_KEYS) {
        for (const option of optionsFor(key)) {
            const pick: Pick = [key, pickValue(key, option)];
            expect({ key, option, refused: refusedByPane({}, pick) }).toEqual({
                key,
                option,
                refused: refusedByWrite([pick]) === 0,
            });
        }
    }
});

test("a compaction target picked against a held trigger", () => {
    agreesWithTheParsers(
        "compactionTriggerFraction",
        "postCompactionTargetFraction",
    );
});

test("a compaction trigger picked against a held target", () => {
    agreesWithTheParsers(
        "postCompactionTargetFraction",
        "compactionTriggerFraction",
    );
});

test("a tool result budget picked against a held ceiling", () => {
    agreesWithTheParsers(
        "toolResultCeilingBytes",
        "toolResultTotalBudgetBytes",
    );
});

test("a tool result ceiling picked against a held budget", () => {
    agreesWithTheParsers(
        "toolResultTotalBudgetBytes",
        "toolResultCeilingBytes",
    );
});
