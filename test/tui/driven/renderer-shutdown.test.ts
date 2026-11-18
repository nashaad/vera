import { expect, test } from "bun:test";
import { Renderable, type CliRenderer } from "@opentui/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { conversation, scrollToRequest } from "../../support/paged-conversation.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("closing a scrolled conversation does not update destroyed renderables", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-shutdown-"));
    const paged = conversation({
        agentId: "paging-test",
        tail: "TAIL",
        older: "OLDER",
        reply: "older",
        hold: true,
    });
    let renderer: CliRenderer | undefined;
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: (testRenderer) => {
            renderer = testRenderer;
            return { client: paged.client, listAgents: async () => [] };
        },
    });
    try {
        await scrollToRequest(session);
        const jump = renderer?.root.findDescendantById("jump-to-bottom");
        if (jump === undefined) throw new Error("Jump to bottom was not created");
        expect(jump.visible).toBe(true);

        const writesAfterDestroy: string[] = [];
        for (const property of ["top", "left"] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(Renderable.prototype, property);
            if (descriptor?.get === undefined || descriptor.set === undefined) {
                throw new Error(`Missing ${property} accessor`);
            }
            Object.defineProperty(jump, property, {
                configurable: true,
                get: () => descriptor.get!.call(jump),
                set: (value: number | `${number}%` | undefined) => {
                    if (jump.isDestroyed) writesAfterDestroy.push(property);
                    else descriptor.set!.call(jump, value);
                },
            });
        }

        paged.release();
        await session.close();
        expect(jump.isDestroyed).toBe(true);
        expect(writesAfterDestroy).toEqual([]);
    } finally {
        paged.release();
        await session.close();
    }
}, 30_000);
