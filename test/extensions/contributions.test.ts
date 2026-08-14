import { expect, test } from "bun:test";

import {
    ExtensionContributionError,
    canonicalWatchId,
    parseExtensionContributions,
} from "../../src/extensions/contributions.ts";
import { parseExtensionManifest } from "../../src/extensions/manifest.ts";

test("a watch contribution carries the source protocol's registration fields", () => {
    const contributions = parseExtensionContributions({
        watches: [
            {
                id: "arc-main",
                source_family: "arc",
                config: {
                    server: "https://arc.local",
                    topics: ["vera-inbox"],
                },
                address: "coordinator",
                flood: "shed",
            },
        ],
    }, "acme.arc-bridge");

    expect(contributions.watches).toEqual([
        {
            id: "arc-main",
            source_family: "arc",
            config: {
                server: "https://arc.local",
                topics: ["vera-inbox"],
            },
            address: "coordinator",
            flood: "shed",
        },
    ]);
});

test("a watch contribution round-trips through JSON unchanged", () => {
    const contributions = parseExtensionContributions({
        watches: [
            {
                id: "arc-main",
                source_family: "arc",
                config: { server: "https://arc.local", depth: 3, live: true },
            },
        ],
    }, "acme.arc-bridge");
    const watch = contributions.watches[0];

    expect(JSON.parse(JSON.stringify(watch))).toEqual(watch as never);
});

test("flood policy defaults to shedding and config defaults to empty", () => {
    const contributions = parseExtensionContributions({
        watches: [{ id: "arc-main", source_family: "arc" }],
    }, "acme.arc-bridge");

    expect(contributions.watches[0]).toEqual({
        id: "arc-main",
        source_family: "arc",
        config: {},
        flood: "shed",
    });
});

test("a missing contributes key yields no contributions", () => {
    expect(parseExtensionContributions(undefined, "acme.arc-bridge"))
        .toEqual({ watches: [], sidecars: [] });
});

test("watch ids are local and canonicalize under the owning extension", () => {
    expect(canonicalWatchId("acme.arc-bridge", "arc-main"))
        .toBe("acme.arc-bridge/arc-main");
});

test("a duplicate local watch id fails the extension by name", () => {
    expect(() => parseExtensionContributions({
        watches: [
            { id: "arc-main", source_family: "arc" },
            { id: "arc-main", source_family: "arc" },
        ],
    }, "acme.arc-bridge")).toThrow(
        /acme\.arc-bridge.*duplicate watch id "arc-main"/,
    );
});

test("an unknown contribution kind is one readable attributed error", () => {
    expect(() => parseExtensionContributions({
        tools: [],
    }, "acme.arc-bridge")).toThrow(
        /acme\.arc-bridge.*unknown contribution kind "tools"/,
    );
});

test("malformed watch fields are rejected with the extension named", () => {
    const malformed: readonly unknown[] = [
        { watches: {} },
        { watches: [{ source_family: "arc" }] },
        { watches: [{ id: "Arc Main", source_family: "arc" }] },
        { watches: [{ id: "arc-main" }] },
        { watches: [{ id: "arc-main", source_family: "Arc" }] },
        { watches: [{ id: "arc-main", source_family: "arc", config: [] }] },
        { watches: [{ id: "arc-main", source_family: "arc", address: "" }] },
        { watches: [{ id: "arc-main", source_family: "arc", flood: "drop" }] },
    ];

    for (const value of malformed) {
        expect(() => parseExtensionContributions(value, "acme.arc-bridge"))
            .toThrow(ExtensionContributionError);
    }
});

test("a watch config holds inert JSON values only", () => {
    expect(() => parseExtensionContributions({
        watches: [
            {
                id: "arc-main",
                source_family: "arc",
                config: { render: () => "now" },
            },
        ],
    }, "acme.arc-bridge")).toThrow(ExtensionContributionError);
});

test("a manifest parses its contributions alongside its identity", () => {
    const manifest = parseExtensionManifest({
        id: "acme.arc-bridge",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: [],
        contributes: {
            watches: [{ id: "arc-main", source_family: "arc" }],
        },
    });

    expect(manifest?.contributes.watches).toHaveLength(1);
});

test("a sidecar contribution parses its command, env, cwd, and restart", () => {
    const contributions = parseExtensionContributions({
        sidecars: [
            {
                id: "worker",
                command: ["bun", "run", "main.ts"],
                env: { TOPIC: "vera" },
                cwd: "worker",
                restart: false,
            },
        ],
    }, "acme.tools");

    expect(contributions.sidecars[0]).toEqual({
        id: "worker",
        command: ["bun", "run", "main.ts"],
        env: { TOPIC: "vera" },
        cwd: "worker",
        restart: false,
    });
});

test("a sidecar defaults to restart with no env and no cwd", () => {
    const contributions = parseExtensionContributions({
        sidecars: [{ id: "worker", command: ["bun", "main.ts"] }],
    }, "acme.tools");

    expect(contributions.sidecars[0]).toEqual({
        id: "worker",
        command: ["bun", "main.ts"],
        env: {},
        restart: true,
    });
});

test("a sidecar refuses malformed declarations", () => {
    for (const sidecar of [
        { command: ["bun"] },
        { id: "Worker", command: ["bun"] },
        { id: "worker" },
        { id: "worker", command: [] },
        { id: "worker", command: ["bun", ""] },
        { id: "worker", command: "bun main.ts" },
        { id: "worker", command: ["bun"], env: { PORT: 5 } },
        { id: "worker", command: ["bun"], cwd: "" },
        { id: "worker", command: ["bun"], restart: "yes" },
    ]) {
        expect(() => parseExtensionContributions({ sidecars: [sidecar] }, "acme.tools"))
            .toThrow(ExtensionContributionError);
    }
});

test("duplicate sidecar ids within one extension are refused", () => {
    expect(() => parseExtensionContributions({
        sidecars: [
            { id: "worker", command: ["bun"] },
            { id: "worker", command: ["node"] },
        ],
    }, "acme.tools")).toThrow(ExtensionContributionError);
});
