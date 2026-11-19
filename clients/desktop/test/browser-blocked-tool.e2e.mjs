import { createServer } from "node:http";

import { BLOCKED_ANNEX_OPEN_ERROR } from "../src/browser/origin-guard.ts";
import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const prompt = "Check the Browser guard";
const seen = [];
let annexUrl;
let redirectUrl;
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
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Ready." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
            return;
        }
        const messages = body.messages ?? [];
        const start = messages.findLastIndex((message) => message.role === "user" && (typeof message.content === "string"
            ? message.content.trim() === prompt
            : JSON.stringify(message.content).includes(prompt)));
        const results = start < 0 ? [] : messages.slice(start + 1).filter((message) => message.role === "tool");
        if (start >= 0) seen.splice(0, seen.length, ...results.map((result) => String(result.content)));
        const inputs = [{ action: "read" }, { action: "open", url: annexUrl }, { action: "open", url: redirectUrl }];
        const input = start === -1 ? undefined : inputs[results.length];
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (input === undefined) response.write(streamChunk(body.model, { role: "assistant", content: start < 0 ? "Ready." : "Browser guard check complete." }, "stop"));
        else response.write(streamChunk(body.model, { role: "assistant", tool_calls: [{ index: 0, id: `guard-${results.length}`, type: "function", function: { name: "builtin_browser", arguments: JSON.stringify(input) } }] }, "tool_calls"));
        response.end("data: [DONE]\n\n");
    });
});
const site = createServer((_request, response) => {
    response.writeHead(302, { location: annexUrl });
    response.end();
});
const trial = startTrial();
let page;
let failed = false;
try {
    await Promise.all([provider, site].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
    configureFauxHome(trial.home, provider.address().port, "ask");
    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    const pane = page.locator('[data-location="rightPane"]');
    const palette = page.locator('input[aria-label="Command palette"]');
    await press(app, "K", [MODIFIER]);
    await palette.fill("Usage");
    await page.locator('[data-command="page.usage"]').click();
    const frame = pane.locator('iframe[title="Usage"]');
    await frame.waitFor();
    annexUrl = await frame.getAttribute("src");
    if (annexUrl === null) throw new Error("Usage has no annex URL.");
    redirectUrl = `http://127.0.0.1:${site.address().port}/redirect`;
    await press(app, "K", [MODIFIER]);
    await palette.fill("Open a web page");
    await page.locator('[data-command="page.openBrowser"]').click();
    const tools = pane.getByRole("switch", { name: "Browser tools" });
    await until("Browser tools ready", async () => await tools.isEnabled());
    await tools.click();
    await until("Browser tools enabled", async () => await tools.isChecked());
    await press(app, "K", [MODIFIER]);
    await palette.fill("Usage");
    await page.locator('[data-command="page.usage"]').click();
    await frame.waitFor();
    const composer = page.locator(".composer-input");
    await composer.fill(prompt);
    await composer.press("Enter");
    const approval = page.locator('.request-card[data-kind="approval"]');
    await approval.waitFor({ timeout: 30_000 });
    await approval.locator('[data-choice="allow_similar"]').click();
    await approval.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("Browser guard check complete.").waitFor({ timeout: 45_000 });
    if (!seen[0]?.startsWith("No web page is open")) throw new Error(`The Usage page was exposed as a web page: ${JSON.stringify(seen)}`);
    if (!seen[1]?.includes(BLOCKED_ANNEX_OPEN_ERROR) || !seen[2]?.includes(BLOCKED_ANNEX_OPEN_ERROR)) {
        throw new Error(`Direct and redirected annex opens did not return the guard error: ${JSON.stringify(seen)}`);
    }
    console.log("browser blocked tool e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    site.closeAllConnections();
    await Promise.all([provider, site].map((server) => new Promise((resolve) => server.close(resolve))));
}
process.exit(failed ? 1 : 0);
