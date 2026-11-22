import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

function hostRequest(socketPath, request, terminal, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = "";
        const timer = setTimeout(() => finish(new Error("Host request timed out")), timeout);
        const finish = (error, result) => {
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error); else resolve(result);
        };
        socket.setEncoding("utf8");
        socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk) => {
            buffer += chunk;
            if (buffer.length > 4096) return finish(new Error("Host reply too large"));
            for (;;) {
                const newline = buffer.indexOf("\n");
                if (newline < 0) break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                try {
                    const result = JSON.parse(line);
                    if (terminal(result)) return finish(undefined, result);
                } catch (error) { return finish(error); }
            }
        });
        socket.once("error", (error) => finish(error));
        socket.once("end", () => finish(new Error("Host closed before reply")));
    });
}

const exec = promisify(execFile);

async function externalSettings(trial, patch) {
    const { socket_path: socket } = JSON.parse(readFileSync(join(trial.home, "runtime", "host.json"), "utf8"));
    const script = `import { requestExtensionThroughHost } from "./src/host/extension-request-client.ts";
        await requestExtensionThroughHost(process.argv[1], "vera.builtin-browser", "settings", JSON.parse(process.argv[2]), AbortSignal.timeout(5000));`;
    await exec("bun", ["-e", script, socket, JSON.stringify(patch)], { cwd: trial.root, timeout: 10_000 });
}

async function stopTrialHost(trial) {
    const record = JSON.parse(readFileSync(join(trial.home, "runtime", "host.json"), "utf8"));
    const path = typeof record.socket_path === "string" ? relative(trial.home, record.socket_path) : "";
    if (!Number.isInteger(record.pid) || record.pid <= 0 || typeof record.started_at !== "string" || Number.isNaN(Date.parse(record.started_at)) || !path || path.startsWith("..") || isAbsolute(path)) throw new Error("Invalid trial host lock");
    const identity = await hostRequest(record.socket_path, { type: "host_identity" }, (result) => result.type === "host_identity");
    if (identity.pid !== record.pid || identity.started_at !== record.started_at || !Number.isInteger(identity.protocol_version)) throw new Error("Trial host identity mismatch");
    const response = await hostRequest(record.socket_path, { type: "shutdown_if_idle", pid: identity.pid, started_at: identity.started_at, requester_protocol_version: identity.protocol_version }, () => true);
    const responses = [identity, response];
    if (response.type !== "shutdown_if_idle_accepted") {
        const stopped = await hostRequest(record.socket_path, { type: "stop_host", pid: identity.pid, started_at: identity.started_at }, (result) => result.type !== "stop_host_waiting", 15000);
        responses.push(stopped);
        if (stopped.type !== "stop_host_stopped") throw new Error(`Graceful stop refused: ${JSON.stringify(responses)}`);
    }
    writeFileSync(join(proof, "shutdown.json"), JSON.stringify({ home: trial.home, responses }, null, 2));
    await until("trial host exit", () => {
        try { process.kill(record.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    }, 20000);
}

const proof = process.env.VERA_BROWSER_HINT_PROOF || "/tmp/browserhint-proof";
mkdirSync(proof, { recursive: true });
const requests = [];
const prompts = ["Check the disabled browser", "Check the enabled browser"];
const provider = createServer((request, response) => {
    if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        writeFileSync(join(proof, "requests.json"), JSON.stringify(requests, null, 2));
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Ready." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
            return;
        }
        const messages = body.messages ?? [];
        const start = messages.findLastIndex((message) => message.role === "user" && prompts.some((prompt) => JSON.stringify(message.content).includes(prompt)));
        const results = start < 0 ? [] : messages.slice(start + 1).filter((message) => message.role === "tool");
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (start < 0 || results.length > 0) {
            const text = start < 0 ? "Ready." : JSON.stringify(messages[start].content).includes(prompts[0]) ? "Disabled check complete." : "Enabled check complete.";
            response.write(streamChunk(body.model, { role: "assistant", content: text }, "stop"));
        } else {
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [{ index: 0, id: `browser-${requests.length}`, type: "function", function: { name: "builtin_browser", arguments: JSON.stringify({ action: "read" }) } }] }, "tool_calls"));
        }
        response.end("data: [DONE]\n\n");
    });
});
const trial = startTrial();
let app;
let failed = false;
try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "ask");
    app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    await externalSettings(trial, { enabled: false, offBehavior: "refuse" });
    const composer = page.locator(".composer-input");
    await composer.fill(prompts[0]);
    await composer.press("Enter");
    const approval = page.locator('.request-card[data-kind="approval"]');
    await approval.waitFor({ timeout: 30_000 });
    await approval.locator('[data-choice="allow_similar"]').click();
    await page.getByText("Disabled check complete.").waitFor({ timeout: 45_000 });
    const notice = page.getByText("Browser tools are off. Open Browser in the right pane, turn on the Browser tools switch, then try again.", { exact: true });
    await notice.waitFor();
    const run = page.locator(".run").filter({ has: notice });
    if (await run.getAttribute("data-open") !== "false") throw new Error("Failed run is not collapsed");
    const button = run.getByRole("button", { name: "Open Browser" });
    await button.waitFor();
    const geometry = await page.evaluate(() => {
        const text = [...document.querySelectorAll(".run-notice")].find((element) => element.textContent?.includes("Browser tools are off."));
        const button = text?.parentElement?.querySelector(".button");
        if (!text || !button) throw new Error("Missing notice geometry");
        const rect = (element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right }; };
        return { text: rect(text), button: rect(button), viewport: { width: innerWidth, height: innerHeight } };
    });
    writeFileSync(join(proof, "notice-geometry.json"), JSON.stringify(geometry, null, 2));
    if (geometry.button.y < geometry.text.bottom || geometry.button.right > geometry.viewport.width || geometry.button.bottom > geometry.viewport.height) throw new Error("Notice action is clipped or overlaps text");
    await page.screenshot({ path: join(proof, "collapsed-notice.png") });
    const count = requests.length;
    await button.click();
    const tools = page.locator('[data-location="rightPane"]').getByRole("switch", { name: "Browser tools" });
    await until("Browser switch available", () => tools.isEnabled());
    if (await tools.isChecked()) throw new Error("Opening Browser enabled tools");
    await page.waitForTimeout(500);
    if (requests.length !== count) throw new Error("Opening Browser sent a model request");
    await page.screenshot({ path: join(proof, "browser-open-off.png") });
    await tools.click();
    await until("Browser tools enabled", () => tools.isChecked());
    await composer.fill(prompts[1]);
    await composer.press("Enter");
    const nextApproval = page.locator('.request-card[data-kind="approval"]');
    if (await nextApproval.isVisible().catch(() => false)) await nextApproval.locator('[data-choice="allow_similar"]').click();
    await page.getByText("Enabled check complete.").waitFor({ timeout: 45_000 });
    const results = requests.flatMap((body) => (body.messages ?? []).filter((message) => message.role === "tool"));
    if (!results.some((message) => String(message.content).includes("Browser tools are off"))) throw new Error("Disabled tool result missing from provider request");
    if (!results.some((message) => String(message.content).includes("No web page is open"))) throw new Error("Enabled tool did not reach Browser");
    if (requests.some((body) => JSON.stringify(body.messages ?? []).includes('"presentation"')) || results.some((message) => "action" in message || String(message.content).includes("open_browser"))) throw new Error("Presentation metadata reached provider");
    const sessionId = await page.locator('[data-session][data-phase="attached"]').first().getAttribute("data-session");
    if (!sessionId) throw new Error("No attached trial session");
    await page.reload();
    await page.locator(`.session-row[data-session="${sessionId}"]`).click({ timeout: 45_000 });
    await notice.waitFor({ timeout: 45_000 });
    await page.getByRole("button", { name: "Open Browser" }).waitFor();
    const reopen = async () => {
        await page.reload();
        await page.locator(`.session-row[data-session="${sessionId}"]`).click({ timeout: 45_000 });
        await notice.waitFor({ timeout: 45_000 });
    };
    const hiddenFlags = await page.evaluate(() => window.veraDesktop.saveFlags({ browser: "off" }));
    if (hiddenFlags?.browser !== "off") throw new Error("Could not hide Browser");
    await reopen();
    await page.waitForTimeout(500);
    if (await page.getByRole("button", { name: "Open Browser" }).count() !== 0) throw new Error("Hidden Browser left an executable action");
    const shownFlags = await page.evaluate(() => window.veraDesktop.saveFlags({ browser: "on" }));
    if (shownFlags?.browser !== "on") throw new Error("Could not restore Browser");
    await reopen();
    await page.getByRole("button", { name: "Open Browser" }).waitFor({ timeout: 45_000 });
    console.log("browser hint recovery, replay, hidden and restored availability passed");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    try {
        if (app !== undefined) await app.close();
        if (trial.hostPid() !== undefined) {
            await stopTrialHost(trial);
        }
        if (trial.hostPid() !== undefined) throw new Error("Trial host remains alive");
        await trial.cleanup();
    } catch (error) {
        failed = true;
        console.error(`Trial retained at ${trial.trialRoot}:`, error);
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
