import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Renderable } from "@opentui/core";

import { createSettingsAnsweringClient } from "../support/settings-answering-client.ts";
import { startTuiTestSession } from "../support/tui-harness.ts";

const SWITCHES = 10;
const ENTRIES = 300;

function transcript(marker: string) {
    return Array.from({ length: ENTRIES }, (_, index) => (
        index % 2 === 0
            ? { kind: "user" as const, text: `${marker} ROW${index} ${"words ".repeat(8)}` }
            : { kind: "assistant" as const, text: `${marker} ANSWER${index} ${"words ".repeat(8)}` }
    ));
}

function collectRenderables(root: Renderable, into: Set<Renderable> = new Set()): Set<Renderable> {
    into.add(root);
    for (const child of root.getChildren()) collectRenderables(child, into);
    return into;
}

test("switching sessions leaves no renderables from earlier sessions attached", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-switch-renderables-"));
    let created = 0;
    let renderer: { readonly root: Renderable } | undefined;
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: (harnessRenderer) => {
            renderer = harnessRenderer;
            return {
                client: createSettingsAnsweringClient({
                    agentId: "start-session",
                    workspace: "/work/vera",
                    model: "start-model",
                    mode: "review",
                    initialUpdates: [{ type: "history", entries: transcript("START"), seq: 0 }],
                }),
                listAgents: async () => [],
                createSession: async (workspace) => {
                    created += 1;
                    return createSettingsAnsweringClient({
                        agentId: `session-${created}`,
                        workspace,
                        model: "next-model",
                        mode: "review",
                        initialUpdates: [{ type: "history", entries: transcript(`SESSION${created}`), seq: 0 }],
                    });
                },
                closeSession: async () => ({ status: "closed", sessionRetained: true }),
            };
        },
    });
    const counts: number[] = [];
    const firstTree = new Set<Renderable>();
    const survivors: number[] = [];
    try {
        await session.waitForVisiblePane("START ROW");
        for (let index = 1; index <= SWITCHES; index += 1) {
            session.sendText("/clear");
            session.sendKey("Enter");
            await session.waitForVisiblePane("Close this conversation");
            await session.settle(50);
            session.sendKey("Enter");
            await session.waitForVisiblePane(`SESSION${index} ROW`);
            await session.settle(100);
            const tree = collectRenderables(renderer!.root);
            counts.push(tree.size);
            if (index === 1) {
                for (const node of tree) firstTree.add(node);
            } else {
                survivors.push([...firstTree].filter((node) => !node.isDestroyed).length);
            }
        }
        expect(Math.max(...counts)).toBeLessThanOrEqual(counts[0]! * 1.2);
        expect(survivors[survivors.length - 1]).toBe(survivors[0]);
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 120_000);
