import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadPoolFile,
    poolFileIssueNotices,
} from "../../src/model/pool-file-loader.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a missing file at either scope loads as empty", () => {
    const root = makeDirectory();

    const loaded = loadPoolFile({
        userPath: join(root, "absent.json"),
        projectPath: join(root, "also-absent.json"),
    });

    expect(loaded.merged).toEqual({ defaults: {}, models: {} });
    expect(loaded.issues).toEqual([]);
});

test("the project file wins per field and keeps unmentioned user fields", () => {
    const userPath = writePool({
        defaults: { subagent: "self", allow: ["*"], deny: ["a/b"] },
    });
    const projectPath = writePool({ defaults: { deny: ["c/d"] } });

    const loaded = loadPoolFile({ userPath, projectPath });

    expect(loaded.merged.defaults).toEqual({
        subagent: "self",
        allow: ["*"],
        deny: ["c/d"],
    });
});

test("model entries merge field by field, and effort keys merge individually", () => {
    const userPath = writePool({
        models: {
            "bedrock/claude-sonnet-5": {
                family: "claude",
                context: 1000000,
                efforts: { low: "low", high: "high" },
            },
        },
    });
    const projectPath = writePool({
        models: {
            "bedrock/claude-sonnet-5": { efforts: { high: null } },
        },
    });

    const loaded = loadPoolFile({ userPath, projectPath });

    expect(loaded.merged.models["bedrock/claude-sonnet-5"]).toEqual({
        family: "claude",
        context: 1000000,
        efforts: { low: "low", high: null },
    });
});

test("a model only the project declares is added to the merge", () => {
    const userPath = writePool({ models: { "openai/gpt-5": { tools: true } } });
    const projectPath = writePool({
        models: { "openai/gpt-5-mini": { tools: false } },
    });

    const loaded = loadPoolFile({ userPath, projectPath });

    expect(Object.keys(loaded.merged.models).sort())
        .toEqual(["openai/gpt-5", "openai/gpt-5-mini"]);
});

test("a broken project file reports its scope and leaves the user file intact", () => {
    const userPath = writePool({ defaults: { allow: ["*"] } });
    const projectPath = writeText("{ broken");

    const loaded = loadPoolFile({ userPath, projectPath });

    expect(loaded.merged.defaults.allow).toEqual(["*"]);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.scope).toBe("project");
});

test("a project root resolves the project file under .vera", () => {
    const root = makeDirectory();
    mkdirSync(join(root, ".vera"));
    writeFileSync(
        join(root, ".vera", "pool.json"),
        JSON.stringify({ defaults: { deny: ["openrouter/*:free"] } }),
    );

    const loaded = loadPoolFile({
        userPath: join(root, "absent.json"),
        projectRoot: root,
    });

    expect(loaded.merged.defaults.deny).toEqual(["openrouter/*:free"]);
});

function makeDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-pool-"));
    directories.push(directory);
    return directory;
}

test("issues become notices naming the scope, the path and the severity", () => {
    const userPath = writePool({
        defaults: { subagnet: "self" },
        models: { "openrouter/one": { context: "wide" } },
    });

    const notices = poolFileIssueNotices(loadPoolFile({ userPath }).issues);

    expect(notices).toContain(
        "Pool warning: user pool file at defaults.subagnet: unknown field,"
            + " kept but has no effect; expected one of subagent,"
            + " subagentEffort, allow, deny",
    );
    expect(
        notices.some((notice) =>
            notice.startsWith(
                "Pool error: user pool file at models.openrouter/one.context",
            )
        ),
    ).toBe(true);
});

function writePool(value: unknown): string {
    return writeText(JSON.stringify(value));
}

function writeText(text: string): string {
    const path = join(makeDirectory(), "pool.json");
    writeFileSync(path, text);
    return path;
}
