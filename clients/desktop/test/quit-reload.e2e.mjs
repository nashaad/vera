import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isToolApprovalUiRequestUpdate } from "../../../src/engine/protocol.ts";
import { createAgentThroughHost } from "../../../src/host/agent-start-client.ts";
import { listAgentsThroughHost } from "../../../src/host/agent-list-client.ts";
import { attachAgent } from "../../../src/host/attached-client.ts";
import { HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE } from "../../../src/host/capabilities.ts";
import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const trial = startTrial();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pidFile = join(trial.trialRoot, "crow.pid");
const prompt = "Start the crow trial command";
const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        const last = body.messages?.at(-1);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (last?.role === "user" && JSON.stringify(last.content).includes(prompt)) {
            const call = {
                index: 0,
                id: "crow-command",
                type: "function",
                function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: `echo $$ > '${pidFile}'; exec sleep 600`, yield_after: 0 }),
                },
            };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        } else {
            response.write(streamChunk(body.model, { role: "assistant", content: "The crow is ready." }, "stop"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};
const socket = join(trial.home, "runtime", "host.sock");
let pid;
let host;
let hostExited;
let failed = false;

async function seed() {
    const agent = await createAgentThroughHost(socket, trial.home);
    const client = await attachAgent({
        socketPath: socket,
        agentId: agent.id,
        interactive: true,
        clientId: "desktop-quit-reload-trial",
        requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
    });
    try {
        await client.receive(AbortSignal.timeout(10_000));
        await client.send({ type: "prompt", content: prompt });
        for (;;) {
            const update = await client.receive(AbortSignal.timeout(10_000));
            if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                await client.send({ type: "ui_response", requestId: update.requestId, response: { type: "tool_approval", decision: "allow_once" } });
            }
            if (update.type === "turn_finished") break;
        }
        await until("the background process", () => existsSync(pidFile));
        pid = Number(readFileSync(pidFile, "utf8").trim());
        if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) throw new Error("The background process did not start.");
        const release = await client.release("keep_running");
        if (release.outcome !== "detached") throw new Error(`Unexpected release: ${release.outcome}`);
        let row;
        await until("the background command to be counted", async () => {
            row = (await listAgentsThroughHost(socket)).find((entry) => entry.id === agent.id);
            return row?.background_commands === 1;
        });
        return row;
    } finally {
        client.close();
    }
}

async function attach(page, agent) {
    await page.getByRole("button", { name: new RegExp(`${agent.name}|${prompt}`) }).first().click({ timeout: 20_000 });
    await page.getByText(prompt, { exact: true }).first().waitFor({ timeout: 20_000 });
    await until("the open conversation", async () =>
        await page.locator(`[data-session="${agent.id}"][data-phase="attached"]`).count() > 0);
}

async function reload(app, page, force) {
    const loaded = page.waitForEvent("load", { timeout: 15_000 });
    await app.evaluate(({ BrowserWindow }, forceReload) => {
        const { webContents } = BrowserWindow.getAllWindows()[0];
        if (forceReload) webContents.reloadIgnoringCache();
        else webContents.reload();
    }, force);
    await loaded;
    await page.locator(".app").first().waitFor({ timeout: 20_000 });
    if (page.isClosed() || !alive(pid)) throw new Error("Reload closed the window or stopped the command.");
    if (await page.locator('[data-overlay="quit-background-commands"]').count() !== 0) {
        throw new Error("Reload showed the quit warning.");
    }
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    host = spawn(process.execPath, [join(repoRoot, "clients/host/main.ts"), "--single-process"], {
        cwd: repoRoot,
        env: {
            ...process.env,
            HOME: trial.userHome,
            VERA_HOME: trial.home,
            VERA_DEV_INSTANCE: `${basename(repoRoot)} e2e`,
            VERA_SOURCE_CHECKOUT: repoRoot,
        },
        stdio: "ignore",
    });
    hostExited = new Promise((resolveExit) => {
        host.once("exit", resolveExit);
        host.once("error", resolveExit);
    });
    await trial.waitForHost();
    const hostBuild = JSON.parse(readFileSync(join(trial.home, "runtime", "host.json"), "utf8")).build_id;
    if (hostBuild !== "e2e") throw new Error(`Trial host used build ${hostBuild}, expected e2e.`);
    const agent = await seed();
    const app = await trial.launch();
    const page = await app.firstWindow();
    await attach(page, agent);

    await reload(app, page, false);
    await attach(page, agent);
    await reload(app, page, true);
    await attach(page, agent);
    console.log("Reload and Force Reload kept the window and background command running.");

    const warning = page.locator('[data-overlay="quit-background-commands"]');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await warning.waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await warning.waitFor({ state: "detached", timeout: 10_000 });
    await reload(app, page, false);
    await attach(page, agent);
    console.log("Escape cancelled the close, and the next reload stayed open.");

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await warning.waitFor({ timeout: 10_000 });
    await reload(app, page, true);
    await attach(page, agent);
    console.log("Force Reload also worked while a quit warning was open.");

    if (process.platform === "darwin") {
        await app.evaluate(({ Menu }) => { setTimeout(() => Menu.sendActionToFirstResponder("terminate:"), 50); });
    } else {
        await app.evaluate(({ app: electronApp }) => electronApp.quit());
    }
    await warning.waitFor({ timeout: 10_000 });
    await warning.getByRole("button", { name: "Keep running" }).click();
    if (!page.isClosed()) await page.waitForEvent("close", { timeout: 10_000 });
    if (!alive(pid)) throw new Error("Keep running stopped the background command.");

    const second = await trial.launch();
    const secondPage = await second.firstWindow();
    await attach(secondPage, agent);
    await second.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const stopWarning = secondPage.locator('[data-overlay="quit-background-commands"]');
    await stopWarning.waitFor({ timeout: 10_000 });
    await stopWarning.getByRole("button", { name: "Stop and quit" }).click();
    if (!secondPage.isClosed()) await secondPage.waitForEvent("close", { timeout: 10_000 });
    await until("the background command to stop", () => !alive(pid));
    console.log("Native Quit kept the command, and last-window Stop and quit stopped it.");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    try {
        await trial.cleanup();
        if (hostExited !== undefined) await hostExited;
    } catch (error) {
        failed = true;
        console.error(`Trial retained at ${trial.trialRoot}:`, error);
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    if (pid !== undefined && alive(pid)) {
        failed = true;
        console.error(`Trial cleanup left process ${pid} running.`);
    }
}
process.exit(failed ? 1 : 0);
