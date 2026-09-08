import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const hint = "m Models · esc cancel";
const home = () => mkdtempSync(join(tmpdir(), "vera-model-shortcut-"));

test("Ctrl+X then M opens models from Home after waiting, without creating a conversation", async () => {
    let created = 0;
    const session = await startTuiTestSession({ home: home(), width: 120, height: 36,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createHomeClient("/work/vera", { readModelSettings: async () => ({ model: "", availableModels: [], pooled: [] }) }),
            createSession: async () => { created++; throw new Error("Opening the picker must not create a conversation"); },
        }),
    });
    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-x");
        await session.waitForVisiblePane(hint);
        await session.settle(5_000);
        expect(session.captureVisiblePane()).toContain(hint);
        session.sendText("m");
        await session.waitForVisiblePane("Switch model");
        expect(session.captureVisiblePane()).not.toContain(hint);
        expect(created).toBe(0);
        session.sendKey("Escape");
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-x"); await session.waitForVisiblePane(hint);
        session.sendKey("Escape"); await session.settle();
        expect(session.captureVisiblePane()).toContain("V  E  R  A");
        expect(session.captureVisiblePane()).not.toContain(hint);
        expect(created).toBe(0);
    } finally { await session.close(); }
}, 15_000);

test("prefix cancellation preserves the draft and caret, and Enter cannot submit it", async () => {
    const commands: string[] = [];
    const session = await startTuiTestSession({ home: home(), width: 120, height: 36,
        dependencies: () => createTuiCatalogRefreshDependencies({ onCommand: (command) => commands.push(command.type) }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("draft"); session.sendKey("Left");
        session.sendKey("C-x"); await session.waitForVisiblePane(hint);
        session.sendKey("Escape"); await session.settle(); session.sendText("X");
        await session.waitForVisiblePane("drafXt");
        session.sendKey("C-x"); await session.waitForVisiblePane(hint);
        session.sendKey("Enter"); await session.settle();
        expect(session.captureVisiblePane()).toContain("drafXt");
        expect(session.captureVisiblePane()).not.toContain(hint);
        expect(commands).not.toContain("prompt");
        session.sendKey("C-x"); await session.waitForVisiblePane(hint);
        session.sendText("m"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Escape"); await session.waitForVisiblePane("drafXt");
        expect(session.captureVisiblePane()).not.toContain(hint);
        session.sendKey("C-x"); await session.waitForVisiblePane(hint);
        session.sendText("q"); session.sendText("m"); await session.settle();
        expect(session.captureVisiblePane()).not.toContain("Switch model");
        expect(session.captureVisiblePane()).toContain("drafXmt");
        expect(commands).not.toContain("prompt");
    } finally { await session.close(); }
}, 15_000);

test("paste cancels the prefix and search fields keep ordinary typing", async () => {
    const session = await startTuiTestSession({ home: home(), width: 120, height: 36,
        dependencies: () => createTuiCatalogRefreshDependencies(),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-x"); await session.waitForVisiblePane(hint);
        await session.sendPaste("draft");
        session.sendText("m"); await session.waitForVisiblePane("draftm");
        expect(session.captureVisiblePane()).not.toContain(hint);
        expect(session.captureVisiblePane()).not.toContain("Switch model");
        session.sendKey("C-x"); await session.waitForVisiblePane(hint);
        session.sendText("m"); await session.waitForVisiblePane("Switch model");
        session.sendText("ab"); session.sendKey("Left");
        session.sendKey("C-x"); session.sendText("m");
        await session.waitForVisiblePane("amb");
        expect(session.captureVisiblePane()).not.toContain(hint);
    } finally { await session.close(); }
}, 15_000);
