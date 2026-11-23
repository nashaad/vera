import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { startTrial } from "./trial.mjs";

const trial = startTrial();
const socketPath = join(trial.trialRoot, "mock.sock");
const waiting = new Set();
const sockets = new Set();
let listRequestedAt;
const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); waiting.delete(socket); });
    socket.on("error", () => {});
    let text = "";
    socket.on("data", (chunk) => {
        text += chunk.toString();
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        let request;
        try { request = JSON.parse(text.slice(0, newline)); } catch { socket.end(); return; }
        if (request.type === "list_agents") {
            listRequestedAt ??= performance.now();
            waiting.add(socket);
        } else if (request.type === "host_identity") {
            socket.end(`${JSON.stringify({ type: "host_identity", pid: 424242, protocol_version: 7, build_id: "trial" })}\n`);
        } else {
            socket.end(`${JSON.stringify({ type: "protocol_error", reason: "unsupported_or_invalid_command" })}\n`);
        }
    });
});

try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
    const cache = join(trial.home, "machine", "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "desktop-session-rows.json"), JSON.stringify([{
        id: "stale-crow", name: "Cached crow", workspace: "", status: "idle", live: false, chat: true,
    }]));
    const cli = join(trial.trialRoot, "mock-cli.js");
    writeFileSync(cli, `console.log(JSON.stringify({type:"ready",pid:424242,socket_path:${JSON.stringify(socketPath)},build_id:"trial"}));\n`);
    const app = await trial.launch({ env: { VERA_DESKTOP_DEV_CLI: cli } });
    const page = await app.firstWindow();
    const stale = page.locator('[data-session="stale-crow"]');
    await stale.waitFor({ timeout: 30_000 });
    const list = page.locator('.sessions-view');
    assert.equal(await list.getAttribute("data-stale"), "true");
    assert.equal(await list.evaluate((element) => getComputedStyle(element).opacity), "0.75");
    assert.ok(waiting.size > 0, "the host list request is still pending");
    assert.ok(performance.now() - listRequestedAt < 1_000, "the cached rows appear within one second");
    for (const socket of waiting) {
        socket.end(`${JSON.stringify({ type: "agent_list", agents: [{ id: "fresh-crow", name: "Fresh crow", workspace: "", status: "idle", live: false, chat: true }], total: 1 })}\n`);
    }
    await page.locator('[data-session="fresh-crow"]').waitFor({ timeout: 10_000 });
    assert.equal(await list.getAttribute("data-stale"), null);
    assert.equal(await stale.count(), 0);
    console.log("Stale rows drew before the list reply; fresh rows replaced them.");
} finally {
    await trial.cleanup();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
}
