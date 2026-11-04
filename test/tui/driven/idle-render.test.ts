import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

for (const homeScreen of [false, true]) {
    test(`${homeScreen ? "home" : "idle conversation"} does not request unchanged frames`, async () => {
        let requests = 0;
        const session = await startTuiTestSession({
            home: mkdtempSync(join(tmpdir(), "vera-idle-render-")),
            dependencies: (renderer) => {
                const requestRender = renderer.requestRender.bind(renderer);
                renderer.requestRender = () => {
                    requests += 1;
                    requestRender();
                };
                return {
                    client: homeScreen
                        ? createHomeClient("/work/pirate-crow")
                        : createSettingsAnsweringClient({
                            agentId: "pirate-crow",
                            model: "fixture",
                            mode: "ask",
                        }),
                };
            },
        });
        try {
            await session.waitForVisiblePane(homeScreen ? "V  E  R  A" : "ready");
            await session.settle(300);
            const frame = session.captureSpans();
            requests = 0;
            await Bun.sleep(300);
            expect(requests).toBe(0);
            await session.settle();
            expect(session.captureSpans()).toEqual(frame);

            if (!homeScreen) {
                session.sendText("pirate crow");
                await session.waitForVisiblePane("pirate crow");
                session.sendKey("C-p");
                await session.settle();
                session.sendKey("Escape");
                await session.waitForVisiblePane("pirate crow");
                session.resize(80, 24);
                await session.settle();
                expect(session.captureVisiblePane()).toContain("pirate crow");
                const resized = session.captureSpans();
                requests = 0;
                await Bun.sleep(300);
                expect(requests).toBe(0);
                await session.settle();
                expect(session.captureSpans()).toEqual(resized);
            }
        } finally {
            await session.close();
        }
    });
}
