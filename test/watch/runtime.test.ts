import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OwnedWatchContribution } from "../../src/extensions/contribution-set.ts";
import { parseExtensionContributions } from "../../src/extensions/contributions.ts";
import { Inbox } from "../../src/store/inbox.ts";
import {
    startWatchRuntime,
    startWatchRuntimeIfEnabled,
} from "../../src/watch/runtime.ts";
import type {
    WatchConnector,
    WatchRuntimeContext,
} from "../../src/watch/source.ts";

function ownedWatch(
    id: string,
    sourceFamily = "arc",
): OwnedWatchContribution {
    return {
        id: `vera.arc/${id}`,
        localId: id,
        extensionId: "vera.arc",
        definition: {
            id,
            source_family: sourceFamily,
            config: { server: "https://arc.local" },
            flood: "shed",
        },
    };
}

function parkingConnector(
    onRun: (context: WatchRuntimeContext) => void,
): WatchConnector {
    return {
        sourceFamily: "arc",
        run: (context: WatchRuntimeContext): Promise<void> => {
            onRun(context);
            return new Promise((resolve) => {
                context.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                });
            });
        },
    };
}

describe("watch definitions are data", () => {
    test("a definition round-trips through JSON with no executable field", () => {
        const declared = {
            watches: [{
                id: "main",
                source_family: "arc",
                config: { server: "https://arc.local", topic: "vera-inbox" },
                address: "coordinator",
            }],
        };
        const parsed = parseExtensionContributions(
            JSON.parse(JSON.stringify(declared)),
            "vera.arc",
        );

        const [watch] = parsed.watches;
        expect(JSON.parse(JSON.stringify(watch))).toEqual({
            id: "main",
            source_family: "arc",
            config: { server: "https://arc.local", topic: "vera-inbox" },
            address: "coordinator",
            flood: "shed",
        });
        for (const value of Object.values(watch ?? {})) {
            expect(typeof value).not.toBe("function");
        }
        expect(watch).not.toHaveProperty("cursor");
    });
});

describe("watch runtime", () => {
    test("one task runs per contributed watch, keyed by canonical id", async () => {
        const inbox = Inbox.open(":memory:");
        const started: string[] = [];
        const runtime = startWatchRuntime({
            inbox,
            watches: [ownedWatch("main"), ownedWatch("reviews")],
            connectors: [parkingConnector((ctx) => started.push(ctx.watchId))],
        });
        await Bun.sleep(1);

        expect(started).toEqual(["vera.arc/main", "vera.arc/reviews"]);
        expect(runtime.statuses().map((s) => s.state)).toEqual([
            "running",
            "running",
        ]);

        await runtime.close();
        inbox.close();
    });

    test("a source family with no connector is quarantined, not started", () => {
        const inbox = Inbox.open(":memory:");
        const runtime = startWatchRuntime({
            inbox,
            watches: [ownedWatch("main", "github")],
            connectors: [parkingConnector(() => undefined)],
        });

        const [status] = runtime.statuses();
        expect(status?.state).toBe("quarantined");
        expect(status?.lastError).toContain("github");
        inbox.close();
    });

    test("one failing watch leaves the others running", async () => {
        const inbox = Inbox.open(":memory:");
        const runtime = startWatchRuntime({
            inbox,
            watches: [ownedWatch("main"), ownedWatch("reviews")],
            connectors: [{
                sourceFamily: "arc",
                run: (context: WatchRuntimeContext): Promise<void> => {
                    if (context.watchId === "vera.arc/main") {
                        return Promise.reject(new Error("upstream down"));
                    }
                    return new Promise((resolve) => {
                        context.signal.addEventListener("abort", () => resolve(), {
                            once: true,
                        });
                    });
                },
            }],
        });
        await Bun.sleep(5);

        const states = new Map(
            runtime.statuses().map((status) => [status.watchId, status.state]),
        );
        expect(states.get("vera.arc/main")).not.toBe("running");
        expect(states.get("vera.arc/reviews")).toBe("running");

        await runtime.close();
        inbox.close();
    });

    test("the runtime is off with no inbox and with nothing contributed", () => {
        const inbox = Inbox.open(":memory:");
        expect(startWatchRuntimeIfEnabled(null, { watches: [ownedWatch("main")] }))
            .toBeNull();
        expect(startWatchRuntimeIfEnabled(inbox, { watches: [] })).toBeNull();
        inbox.close();
    });

    test("a watch cursor outlives the extension that contributed it", async () => {
        const directory = mkdtempSync(join(tmpdir(), "vera-watch-"));
        const path = join(directory, "inbox.db");
        try {
            const first = Inbox.open(path);
            const running = startWatchRuntime({
                inbox: first,
                watches: [ownedWatch("main")],
                connectors: [{
                    sourceFamily: "arc",
                    run: async (context: WatchRuntimeContext): Promise<void> => {
                        await context.admit([{
                            id: "arc:7",
                            kind: "arc.post",
                            ts: "2026-07-28T14:00:00Z",
                            actor: "node-a/nash",
                            session: null,
                            cursor: "v1:7",
                            payload: { issue_id: "nash-95" },
                        }]);
                        await new Promise<void>((resolve) => {
                            context.signal.addEventListener("abort", () => resolve(), {
                                once: true,
                            });
                        });
                    },
                }],
            });
            await Bun.sleep(5);
            await running.close();
            first.close();

            // The extension is disabled: nothing is contributed, so no task runs.
            const disabled = Inbox.open(path);
            expect(startWatchRuntimeIfEnabled(disabled, { watches: [] })).toBeNull();
            expect(disabled.watchCursor("vera.arc/main")).toBe("v1:7");
            disabled.close();

            const reenabled = Inbox.open(path);
            const resumed: { cursor: string | null } = { cursor: null };
            const again = startWatchRuntime({
                inbox: reenabled,
                watches: [ownedWatch("main")],
                connectors: [parkingConnector((ctx) => {
                    resumed.cursor = ctx.cursor();
                })],
            });
            await Bun.sleep(1);
            expect(resumed.cursor).toBe("v1:7");
            await again.close();
            reenabled.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
