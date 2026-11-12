// Model picker test for the desktop shell. Run with: node clients/desktop/test/models.e2e.mjs
// A local provider serves two models; the trial home lists the second one off the shortlist.

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const REPLY = "Ravens keep the ledger.";
const RAVEN = {
    id: "crow-1",
    label: "Raven",
    context_window: 32000,
    tool_support: true,
    levels: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
    default_level: "high",
    pricing: { input: 2, output: 8 },
};

const requests = [];

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }, { id: "crow-1" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", async () => {
        const body = JSON.parse(raw);
        const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
        const text = JSON.stringify(user?.content ?? "");
        requests.push({ model: body.model, text });
        // The probe asks for an exact word back.
        const reply = text.match(/Reply with exactly: ([\w-]+)/)?.[1] ?? REPLY;
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        const tool = text.match(/Call (\w+) with value (\w+)/);
        const call = tool === null ? undefined : {
            id: "call-probe",
            type: "function",
            function: { name: tool[1], arguments: JSON.stringify({ value: tool[2] }) },
        };
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [call === undefined
                    ? { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }
                    : { index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
                usage,
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (call !== undefined) {
            response.write(streamChunk(body.model, { tool_calls: [{ index: 0, ...call }] }));
        } else {
            for (const part of reply.split(/(?= )/)) {
                response.write(streamChunk(body.model, { content: part }));
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
        const finish = call === undefined ? "stop" : "tool_calls";
        response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
});

const USER = ":is(.user-turn, .user-bubble)";

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto", [RAVEN]);
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");

    // New Chat: search for Raven, pin it to the shortlist, pick it, then send.
    const modelPill = page.locator(".model-pill");
    await until("the model pill", async () => /crow/i.test(await modelPill.innerText()));
    await modelPill.click();
    await page.locator(".model-search input").fill("raven");
    const ravenRow = page.locator(".model-row", { hasText: "Raven" });
    await ravenRow.locator(".model-pin").click();
    await page.waitForSelector(".model-label:text-is(\"Shortlist\") ~ .model-row:has-text(\"Raven\")", { timeout: 15_000 });
    await ravenRow.locator(".model-item").click();
    await until("Raven on the pill", async () => (await modelPill.innerText()).includes("Raven"));
    await page.waitForSelector(".effort-pill");

    const input = page.locator(".composer-input");
    await input.fill("Hello raven");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`${USER}:text-is("Hello raven")`, { timeout: 30_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });
    await until("the prompt sent to crow-1", async () => requests.some((seen) => seen.model === "crow-1" && seen.text.includes("Hello raven")));

    // In the session: search to Crow, which is off the shortlist, and send on it.
    const send = page.locator(".send-button");
    await until("an idle session", async () => (await send.getAttribute("data-mode")) === "send");
    await until("Raven on the session pill", async () => (await modelPill.innerText()).includes("Raven"));
    await modelPill.click();
    await page.locator(".model-search input").fill("crow");
    await page.locator(".model-row", { hasText: "Crow" }).locator(".model-item").click();
    await until("Crow on the pill", async () => /crow/i.test(await modelPill.innerText()));
    await input.fill("Back to crow");
    await input.press("Enter");
    await page.waitForSelector(`${USER}:text-is("Back to crow")`, { timeout: 30_000 });
    await until("the prompt sent to crow-0", async () => requests.some((seen) => seen.model === "crow-0" && seen.text.includes("Back to crow")));
    await until("an idle session", async () => (await send.getAttribute("data-mode")) === "send");

    // Number key 1 picks Raven, the first shortlist row; then drop its effort to Low with the slider.
    await modelPill.click();
    await page.waitForSelector(".model-menu");
    await page.keyboard.press("1");
    await until("Raven on the pill", async () => (await modelPill.innerText()).includes("Raven"));
    const effortPill = page.locator(".effort-pill");
    await effortPill.click();
    await page.locator(".effort-input").focus();
    await page.keyboard.press("Home");
    await until("Low on the effort pill", async () => (await effortPill.innerText()).includes("Low"));
    await page.keyboard.press("Escape");

    // The browser: select Raven and probe it.
    await modelPill.click();
    await page.getByRole("button", { name: /All models/ }).click();
    await page.waitForSelector(".models-sheet");
    await page.locator(".models-tab", { hasText: "All models" }).click();
    await page.locator(".models-row", { hasText: "Raven" }).click();
    await page.waitForSelector(".models-detail-name:text-is(\"Raven\")");
    const before = requests.length;
    await page.getByRole("button", { name: "Probe it" }).click();
    await page.waitForSelector(".models-probe:text-is(\"Probe passed.\")", { timeout: 30_000 });
    await until("the probe request", async () => requests.slice(before).some((seen) => seen.model === "crow-1"));
    console.log("models e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests);
    if (page !== undefined) {
        const reply = await page.evaluate(() => window.veraDesktop.readModelSettings()).catch((cause) => String(cause));
        const settings = reply?.settings ?? reply;
        const faux = (list) => (list ?? []).filter((row) => String(row.provider).startsWith("faux"));
        console.error("Host settings:", JSON.stringify({ keys: Object.keys(reply ?? {}), pooled: faux(settings?.pooled), available: faux(settings?.availableModels), providers: settings?.providerCatalogs }, null, 1).slice(0, 3000));
    }
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
