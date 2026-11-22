import { createServer } from "node:http";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const requests = [];
const prompts = ["Ask to turn Browser tools on", "Ask to keep Browser tools off"];
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
        const messages = body.messages ?? [];
        const start = messages.findLastIndex((message) => message.role === "user" && prompts.some((prompt) => JSON.stringify(message.content).includes(prompt)));
        const results = start < 0 ? [] : messages.slice(start + 1).filter((message) => message.role === "tool");
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (start < 0 || results.length > 0) {
            const promptIndex = start < 0 ? -1 : prompts.findIndex((prompt) => JSON.stringify(messages[start].content).includes(prompt));
            const text = promptIndex === 0 ? "Turn-on ask complete." : promptIndex === 1 ? "Refusal ask complete." : "Ready.";
            response.write(streamChunk(body.model, { role: "assistant", content: text }, "stop"));
        } else {
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [{ index: 0, id: `browser-${requests.length}`, type: "function", function: { name: "builtin_browser", arguments: JSON.stringify({ action: "read" }) } }] }, "tool_calls"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "ask");
    const app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    const composer = page.locator(".composer-input");
    const notice = page.locator(".browser-tools-notice");
    const approval = page.locator('.request-card[data-kind="approval"]');

    await composer.fill(prompts[0]);
    await composer.press("Enter");
    await approval.waitFor({ timeout: 30_000 });
    await approval.locator('[data-choice="allow_similar"]').click();
    await notice.getByText("Vera wants to use the Browser pane. Turn on Browser tools?", { exact: true }).waitFor({ timeout: 45_000 });
    await notice.getByRole("button", { name: "Turn on", exact: true }).click();
    await page.getByText("Turn-on ask complete.").waitFor({ timeout: 45_000 });
    const enabled = page.locator('[data-location="rightPane"]').getByRole("switch", { name: "Browser tools" });
    await until("Browser tools enabled by ask", () => enabled.isChecked());
    const firstTools = requests.flatMap((body) => (body.messages ?? []).filter((message) => message.role === "tool"));
    if (!firstTools.some((message) => String(message.content).includes("No web page is open"))) throw new Error("Turn on did not carry the original call through");

    await page.evaluate(() => window.veraDesktop.browser("tools", false));
    await composer.fill(prompts[1]);
    await composer.press("Enter");
    if (await approval.isVisible().catch(() => false)) await approval.locator('[data-choice="allow_similar"]').click();
    await notice.getByText("Vera wants to use the Browser pane. Turn on Browser tools?", { exact: true }).waitFor({ timeout: 45_000 });
    await notice.getByRole("button", { name: "Not now", exact: true }).click();
    await page.getByText("Refusal ask complete.").waitFor({ timeout: 45_000 });
    const refusalTools = requests.flatMap((body) => (body.messages ?? []).filter((message) => message.role === "tool"));
    if (!refusalTools.some((message) => String(message.content).includes("The user kept Browser tools off."))) throw new Error("Not now did not refuse the original call");
    const refusal = page.getByText("The user kept Browser tools off.", { exact: true });
    await refusal.waitFor();
    if (await page.locator(".run").filter({ has: refusal }).getByRole("button", { name: "Open Browser" }).count() !== 1) throw new Error("Refused run did not retain Open Browser action");
    console.log("Browser tools ask, turn-on continuation and Not now refusal passed");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    try {
        await trial.cleanup();
    } catch (error) {
        failed = true;
        console.error(`Trial retained at ${trial.trialRoot}:`, error);
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
