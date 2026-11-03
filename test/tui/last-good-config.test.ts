import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiFlightEvent, TuiFlightRecorder } from "../../clients/tui/flight-recorder.ts";
import { lastGoodConfigNotice, readLastGoodConfig } from "../../clients/tui/main/last-good-config.ts";
import { startingVeraConfig, VeraConfigError } from "../../src/config.ts";
import { VERA_HOME_ENV } from "../../src/profile-paths.ts";

test("the notice names the reason and says when older settings are showing", () => {
    const error = new VeraConfigError("/crow/config.json", "it is not valid JSON (JSON Parse error: Expected '}')");
    const config = startingVeraConfig();
    expect(lastGoodConfigNotice({ config: undefined })).toBeUndefined();
    expect(lastGoodConfigNotice({ config, error })).toBe(
        "config.json could not be read: it is not valid JSON (JSON Parse error: Expected '}')."
            + " Showing the last settings that loaded.",
    );
    expect(lastGoodConfigNotice({ config: undefined, error })).toBe(
        "config.json could not be read: it is not valid JSON (JSON Parse error: Expected '}').",
    );
    const sentence = new VeraConfigError("/crow/config.json", "Remove it from providers.");
    expect(lastGoodConfigNotice({ config: undefined, error: sentence })).toBe(
        "config.json could not be read: Remove it from providers.",
    );
});

test("each distinct load error is logged once", () => {
    const previous = process.env[VERA_HOME_ENV];
    const home = mkdtempSync(join(tmpdir(), "vera-last-good-tui-"));
    const events: TuiFlightEvent[] = [];
    const recorder: TuiFlightRecorder = {
        instanceId: "crow", logPath: "",
        record: (event) => { events.push(event); },
        sessionEntered: () => {}, close: () => {},
    };
    const rt = { flightRecorder: recorder };
    const path = join(home, "config.json");
    try {
        process.env[VERA_HOME_ENV] = home;
        writeFileSync(path, JSON.stringify({ schema_version: 1, provider: "openrouter", model: "crow/good" }));
        readLastGoodConfig(rt);
        expect(events).toEqual([]);

        writeFileSync(path, "{ not json");
        readLastGoodConfig(rt);
        readLastGoodConfig(rt);
        expect(events.map((event) => event.type)).toEqual(["config_unreadable"]);

        writeFileSync(path, "[]");
        readLastGoodConfig(rt);
        expect(events).toHaveLength(2);

        writeFileSync(path, JSON.stringify({ schema_version: 1, provider: "openrouter", model: "crow/good" }));
        readLastGoodConfig(rt);
        writeFileSync(path, "[]");
        readLastGoodConfig(rt);
        expect(events).toHaveLength(3);
    } finally {
        if (previous === undefined) delete process.env[VERA_HOME_ENV];
        else process.env[VERA_HOME_ENV] = previous;
    }
});
