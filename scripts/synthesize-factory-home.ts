#!/usr/bin/env bun

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyUsage } from "../src/model/types.ts";

export const FACTORY_HOME_RELATIVE = join("dev", "factory-home");
export const FACTORY_HELLO_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FACTORY_TOOLS_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STAMP = "2026-08-31T12:00:00.000Z";

function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 });
}

function writeText(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o644 });
}

function writeSession(
    path: string,
    sessionId: string,
    name: string,
    userText: string,
    assistantText: string,
): void {
    const userId = `${sessionId}-user`;
    const assistantId = `${sessionId}-assistant`;
    const lines = [
        {
            type: "session",
            version: 1,
            id: sessionId,
            timestamp: STAMP,
            cwd: "/tmp/vera-factory",
        },
        {
            type: "session_name",
            timestamp: STAMP,
            name,
        },
        {
            type: "message",
            id: userId,
            parentId: null,
            timestamp: STAMP,
            message: {
                role: "user",
                content: [{ type: "text", text: userText }],
            },
        },
        {
            type: "message",
            id: assistantId,
            parentId: userId,
            timestamp: STAMP,
            message: {
                role: "assistant",
                content: [{ type: "text", text: assistantText }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        },
    ];
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
        path,
        `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        { mode: 0o600 },
    );
}

/** Write a one-home factory tree. No live credentials, no process identity. */
export function synthesizeFactoryHome(destination: string): void {
    const home = resolve(destination);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "machine"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "extensions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "skills"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "agents"), { recursive: true, mode: 0o700 });
    for (const empty of ["machine", "extensions", "skills", "agents"] as const) {
        writeFileSync(join(home, empty, ".gitkeep"), "", { mode: 0o644 });
    }

    writeJson(join(home, "config.json"), {
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
        experimental: { inbox: false },
        extensions: [],
    });
    writeJson(join(home, "pool.json"), {
        defaults: {},
        models: {
            "openrouter/faux/test": {
                added: true,
                tools: true,
            },
        },
    });
    writeJson(join(home, "preferences.json"), []);
    writeJson(join(home, "tui.json"), {
        theme: "orng",
        workspace_sidebar_docked: true,
    });
    writeText(
        join(home, "memory", "welcome.md"),
        [
            "# Factory home",
            "",
            "This tree is synthesized. It is not a copy of a live Vera home.",
            "Refresh it with `bun run factory:home` after the synthesizer changes.",
            "",
        ].join("\n"),
    );
    writeSession(
        join(home, "runtime", "sessions", `${FACTORY_HELLO_SESSION_ID}.jsonl`),
        FACTORY_HELLO_SESSION_ID,
        "Factory hello",
        "Say hello from the factory home.",
        "Hello from the factory home.",
    );
    writeSession(
        join(home, "runtime", "sessions", `${FACTORY_TOOLS_SESSION_ID}.jsonl`),
        FACTORY_TOOLS_SESSION_ID,
        "Factory tools",
        "List the files in this workspace.",
        "This is a saved factory transcript, not a live tool run.",
    );
}

export function defaultFactoryHomePath(repoRoot = REPO_ROOT): string {
    return join(repoRoot, FACTORY_HOME_RELATIVE);
}

if (import.meta.main) {
    const target = process.argv[2] === undefined
        ? defaultFactoryHomePath()
        : resolve(process.argv[2]);
    synthesizeFactoryHome(target);
    process.stdout.write(`${target}\n`);
}
