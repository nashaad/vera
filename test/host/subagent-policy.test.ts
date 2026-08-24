import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { subagentPoolPolicy } from "../../src/host/subagent-policy.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function poolPath(file: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-subagent-policy-"));
    directories.push(directory);
    const path = join(directory, "pool.json");
    writeFileSync(path, JSON.stringify(file));
    return path;
}

function configPath(file: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-subagent-config-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify(file));
    return path;
}

const PROBED = { probe: { ok: true, seen: "2026-08-06" } };

test("allow, deny, the failsafe list and families come off the pool file", () => {
    const userPath = poolPath({
        defaults: { allow: ["*"], deny: ["openrouter/*:free"] },
        models: {
            "bedrock/claude-sonnet-5": { family: "claude", learned: PROBED },
            "bedrock/nothing-declared": {},
        },
    });

    expect(subagentPoolPolicy({ userPath })).toEqual({
        allow: ["*"],
        deny: ["openrouter/*:free"],
        failsafe: ["bedrock/claude-sonnet-5"],
        families: { "bedrock/claude-sonnet-5": "claude" },
    });
});

test("an unverified pool entry is not a failsafe candidate", () => {
    const userPath = poolPath({
        models: {
            "ollama/never-probed": { added: true },
            "ollama/probed": { added: true, learned: PROBED },
        },
    });

    expect(subagentPoolPolicy({ userPath }).failsafe).toEqual(["ollama/probed"]);
});

test("an entry holding only learned facts is not a failsafe candidate", () => {
    const userPath = poolPath({
        models: { "ollama/ran-once": { learned: PROBED } },
    });

    expect(subagentPoolPolicy({ userPath }).failsafe).toBeUndefined();
});

test("declared tool support is resolved for failsafe candidates only", () => {
    const userPath = poolPath({
        models: {
            "ollama/talks-only": { tools: false, learned: PROBED },
            "ollama/unverified": { tools: true },
        },
    });

    expect(subagentPoolPolicy({ userPath }).tools).toEqual({
        "ollama/talks-only": false,
    });
});

test("a failsafe candidate nothing knows about is left out of tool support", () => {
    const userPath = poolPath({
        models: { "ollama/mystery": { added: true, learned: PROBED } },
    });

    expect(subagentPoolPolicy({ userPath }).tools).toBeUndefined();
});

test("an empty file gates nothing", () => {
    expect(subagentPoolPolicy({ userPath: poolPath({}) })).toEqual({});
});

test("a relative subagent effort reaches the self rung", () => {
    const userPath = poolPath({ defaults: { subagentEffort: "lowest" } });

    expect(subagentPoolPolicy({ userPath }).selfEffort).toBe("lowest");
});

test("an unrecognised subagent effort is dropped rather than passed on", () => {
    const userPath = poolPath({ defaults: { subagentEffort: "brisk" } });

    expect(subagentPoolPolicy({ userPath }).selfEffort).toBeUndefined();
});

test("defaults.subagent reaches the ladder as the configured default", () => {
    const userPath = poolPath({
        defaults: { subagent: "openrouter/worker" },
    });

    expect(subagentPoolPolicy({ userPath }).subagentDefault).toBe(
        "openrouter/worker",
    );
});

test("a default written as a pool name is handed over as the model it names", () => {
    const userPath = poolPath({
        defaults: { subagent: "frosty" },
        models: { "bedrock/claude-haiku-4-5": { name: "frosty" } },
    });

    expect(subagentPoolPolicy({ userPath }).subagentDefault)
        .toBe("bedrock/claude-haiku-4-5");
});

test("a default naming nothing is passed through as the user wrote it", () => {
    const userPath = poolPath({
        defaults: { subagent: "nobody" },
        models: {},
    });

    expect(subagentPoolPolicy({ userPath }).subagentDefault).toBe("nobody");
});

test("the subagents assignment is narrowed to selectable shortlist entries", () => {
    const userPath = poolPath({
        defaults: { deny: ["openrouter/denied"] },
        models: {
            "openrouter/worker": { added: true },
            "openrouter/denied": { added: true },
        },
    });
    const config = configPath({
        schema_version: 1,
        provider: "openrouter",
        model: "parent",
        approval_mode: "auto",
        models: [
            { name: "worker", provider: "openrouter", model: "worker" },
            { name: "denied", provider: "openrouter", model: "denied" },
            { name: "outside", provider: "openrouter", model: "outside" },
        ],
        model_routes: {},
        reviewer_profiles: {},
        model_assignments: {
            subagents: {
                models: [
                    { name: "worker", provider: "openrouter", model: "worker",
                        reasoning_effort: "low" },
                    { name: "denied", provider: "openrouter", model: "denied" },
                    { name: "outside", provider: "openrouter", model: "outside" },
                ],
                allow_self: true,
            },
        },
    });

    expect(subagentPoolPolicy({ userPath, configPath: config })).toMatchObject({
        assigned: [{
            provider: "openrouter",
            model: "worker",
            reasoningEffort: "low",
        }],
        allowSelf: true,
    });
});
