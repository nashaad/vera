import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { routeTuiAgentMessage } from "../../clients/tui/agent-message-routing.ts";
import { startClientExtensionRegistry } from "../../src/extensions/client-registry.ts";

const EXTENSION = join(import.meta.dir, "../../examples/extensions/review-room");
const TUI_ROOT = join(import.meta.dir, "../../clients/tui");

async function start() {
    const calls: unknown[] = [];
    const mounted: { extensionId: string; id: string }[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [{ path: EXTENSION, enabled: true, config: null }],
        preferences: {
            async get() { return undefined; },
            async set() {},
            async delete() {},
        },
        modelSettings: {
            current: () => undefined,
            async update() {
                return { status: "rejected", reason: "unavailable" };
            },
            subscribe: () => () => undefined,
        },
        picker: { async request() { return { outcome: "cancelled" }; } },
        notice: { post() {} },
        experimentalTui: {
            mount(extensionId, spec) {
                mounted.push({ extensionId, id: spec.id });
                return async () => {};
            },
            events: {
                on() {
                    return async () => {};
                },
            },
        },
        agents: {
            visible() {
                return [{ agentId: "author-id", pane: "main" as const }];
            },
            async create(extensionId, request) {
                calls.push({ operation: "create", extensionId, request });
                return { agentId: "critic-id" };
            },
            async open(extensionId, request) {
                calls.push({ operation: "open", extensionId, request });
            },
            async message(extensionId, request) {
                calls.push({ operation: "message", extensionId, request });
            },
        },
    });
    return { registry, calls, mounted };
}

test("review-room declares different hosted-agent policy through the registry", async () => {
    const harness = await start();
    expect(harness.mounted).toEqual([
        { extensionId: "vera.review-room", id: "review-panel" },
        { extensionId: "vera.review-room", id: "review-overlay" },
        { extensionId: "vera.review-room", id: "review-footer" },
        { extensionId: "vera.review-room", id: "review-composer-adornment" },
    ]);
    await harness.registry.invokeCommand(
        "review-room",
        " inspect this ",
        "/workspace",
        undefined,
        1,
        ["/tmp/review.png"],
    );

    expect(harness.registry.experimentalHostedAgentAddressing(
        "vera.review-room",
    )).toEqual({ primary: "author", secondary: "critic" });
    expect(harness.calls).toEqual([
        {
            operation: "create",
            extensionId: "vera.review-room",
            request: {
                pane: "sidebar",
                mention: "critic",
                statusLabel: "review",
                workspace: "/workspace",
                approvalMode: "ask",
                attachmentLifetime: "ephemeral",
            },
        },
        {
            operation: "message",
            extensionId: "vera.review-room",
            request: {
                agentId: "critic-id",
                text: "inspect this",
                imagePaths: ["/tmp/review.png"],
            },
        },
    ]);
    await harness.registry.close();
});

test("review-room declarations drive routing and omit broadcast", async () => {
    const harness = await start();
    const addressing = harness.registry.experimentalHostedAgentAddressing(
        "vera.review-room",
    )!;
    const visible = [
        { agentId: "author-id", pane: "main" as const },
        { agentId: "critic-id", pane: "sidebar" as const },
    ];

    expect(routeTuiAgentMessage(
        "@author publish",
        "sidebar",
        visible,
        addressing,
    )).toEqual({
        kind: "message",
        text: "publish",
        targets: [visible[0]!],
    });
    expect(routeTuiAgentMessage(
        "@critic inspect",
        "main",
        visible,
        addressing,
    )).toEqual({
        kind: "message",
        text: "inspect",
        targets: [visible[1]!],
    });
    expect(routeTuiAgentMessage(
        "@all compare",
        "main",
        visible,
        addressing,
    )).toEqual({ kind: "unknown", mention: "all" });
    await harness.registry.close();
});

test("review vocabulary is absent from TUI source", () => {
    const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: TUI_ROOT }));
    const leaked = files.filter((file) =>
        /\b(?:review-room|author|critic)\b/i.test(
            readFileSync(join(TUI_ROOT, file), "utf8"),
        )
    );
    expect(leaked).toEqual([]);
});
