/** The provider screen driving a local runtime: what the status section says, and what stopping and starting it does. The Outrider on the other end is a fixture, so the journey runs the same on a machine with no runtime installed. */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import type { OutriderDriver } from "../../../clients/tui/main/outrider-ops.ts";

const SMALL = "qwen35-0.8b";
const LARGER = "qwen35-2b";

/** An Outrider that answers from memory. It holds the one fact the screen reads back: which profile, if any, is loaded. */
function fixtureOutrider(ran: string[][], serving: string | undefined = SMALL): OutriderDriver {
    let loaded: string | undefined = serving;
    let gateway = serving !== undefined;
    const answer = (command: readonly string[]): string => {
        if (command[1] === "ls") {
            return JSON.stringify({
                profiles: [SMALL, LARGER].map((id) => ({ id, runnable: true })),
            });
        }
        const verb = command[2] ?? "";
        if (verb === "stop") {
            loaded = undefined;
            gateway = false;
            return "{}";
        }
        if (verb === "serve" || verb === "use" || verb === "start") {
            loaded = command[3] ?? loaded ?? SMALL;
            gateway = true;
            return "{}";
        }
        return JSON.stringify({
            gateway: gateway
                ? { kind: "running", endpoint: "http://127.0.0.1:11435" }
                : { kind: "stopped" },
            model: loaded === undefined
                ? { kind: "stopped" }
                : { kind: "running", preset: loaded, health: true, residentBytes: 600_000_000 },
        });
    };
    return {
        binary: () => "/fixture/outrider",
        run: (command) => {
            ran.push([...command]);
            return {
                finished: Promise.resolve({ ok: true, stdout: answer(command), detail: "" }),
                stop: () => {},
            };
        },
    };
}

function home(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-outrider-"));
    const veraHome = join(root, ".vera");
    mkdirSync(join(veraHome, "runtime", "cache"), { recursive: true });
    writeFileSync(join(veraHome, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "outrider",
        model: SMALL,
        approval_mode: "auto",
    }));
    writeFileSync(join(veraHome, "runtime", "cache", "outrider.json"), JSON.stringify({
        schema_version: 2,
        provider: "outrider",
        fetched_at: new Date().toISOString(),
        models: [SMALL, LARGER].map((id) => ({ id, label: id, levels: [] })),
    }));
    return root;
}

test("the provider screen shows what the local runtime is doing and stops and starts it", async () => {
    const ran: string[][] = [];
    const session = await startTuiTestSession({
        home: home(),
        width: 120,
        height: 40,
        dependencies: () => ({
            ...createTuiCatalogRefreshDependencies({ onCommand: () => {} }),
            outrider: fixtureOutrider(ran),
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("configure providers");
        await session.waitForVisiblePane("Configure providers");
        session.sendKey("Enter");

        // Opening the screen reads the runtime. Nothing is started by looking.
        const open = await session.waitForVisiblePane(`serving ${SMALL}`);
        expect(open).toContain("Local runtime");
        expect(open).toContain("Outrider · serving");
        expect(ran.every((command) => command[2] === "status")).toBe(true);

        session.sendText("outrider");
        await session.settle();
        session.sendKey("Enter");
        const menu = await session.waitForVisiblePane("Switch model");
        expect(menu).toContain("Stop");
        expect(menu).toContain("Restart");
        expect(menu).toContain("Logs");

        // "stop" leaves both Restart and Stop, in that order.
        session.sendText("stop");
        await session.settle();
        session.sendKey("Enter");
        await session.waitForVisiblePane(`serving ${SMALL}`);
        expect(ran.map((command) => command.slice(2).join(" "))).toContain("stop");
        expect(ran.map((command) => command.slice(2).join(" ")))
            .toContain(`serve ${SMALL}`);

        const before = ran.length;
        session.sendKey("Enter");
        await session.waitForVisiblePane("Switch model");
        session.sendText("stop");
        await session.settle();
        session.sendKey("Down");
        session.sendKey("Enter");
        const stopped = await session.waitForVisiblePane("nothing loaded");
        expect(stopped).toContain("Local runtime");

        session.sendKey("Enter");
        const afterStop = await session.waitForVisiblePane("Start");
        expect(afterStop).not.toContain("Restart");
        session.sendText("start");
        await session.settle();
        session.sendKey("Enter");

        // Start serves the profile Vera is pointed at rather than whatever
        // the runtime last held.
        await session.waitForVisiblePane(`serving ${SMALL}`);
        expect(ran.slice(before).map((command) => command.slice(2).join(" ")))
            .toEqual(["stop", "status", "serve qwen35-0.8b", "status"]);

        // Switching is the same model step the wizard uses, listing what this
        // machine's runtime will serve.
        session.sendKey("Enter");
        await session.waitForVisiblePane("Switch model");
        session.sendText("switch");
        await session.settle();
        session.sendKey("Enter");
        const models = await session.waitForVisiblePane(LARGER);
        expect(models).toContain(SMALL);
    } finally {
        await session.close();
    }
}, 30_000);
