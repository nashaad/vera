// Pages test for the desktop shell. Run with: node clients/desktop/test/pages.e2e.mjs
// One session says a rare word; Search finds it, Work shows a slow turn finishing
// while another page is open, the Workspace page counts the folder's sessions and
// Devices describes this machine.

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const RARE = "Quillfeather";
const REPLY = `The heron counts ${RARE} stones by the reef.`;
// Sessions refresh every few seconds, so the slow turn outlasts several refreshes.
const SLOW_CHUNKS = 30;
const SLOW_CHUNK_MS = 300;

function lastUserText(body) {
    const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
    return JSON.stringify(user?.content ?? "");
}

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", async () => {
        const body = JSON.parse(raw);
        const slow = lastUserText(body).includes("SLOW");
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Heron notes" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        let closed = false;
        response.on("close", () => { closed = true; });
        const parts = slow ? Array.from({ length: SLOW_CHUNKS }, () => " tide") : REPLY.split(/(?= )/);
        for (const part of parts) {
            if (closed) return;
            response.write(streamChunk(body.model, { content: part }));
            await new Promise((resolve) => setTimeout(resolve, slow ? SLOW_CHUNK_MS : 20));
        }
        if (closed) return;
        response.write(streamChunk(body.model, {}, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

async function openPage(kind) {
    await page.locator(`[data-page="${kind}"]`).first().click();
    await page.waitForSelector(`main[data-page="${kind}"]`, { timeout: 10_000 });
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const folder = join(trial.home, "..", "nest");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    await page.getByRole("button", { name: /Choose folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"nest\")");
    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");
    await input.fill("Tell me about herons");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 45_000 });
    await until("the turn to end", async () => (await send.getAttribute("data-mode")) === "send");

    // Search finds the session by what was said in it, and marks the word.
    await openPage("search");
    await page.locator("input[aria-label=\"Search sessions\"]").fill(RARE.toLowerCase());
    const hit = page.locator(".list-row[data-session]").first();
    await hit.waitFor({ timeout: 15_000 });
    const marked = await hit.locator(".search-mark").first().innerText();
    if (marked !== RARE) throw new Error(`Search marked ${marked}`);
    await page.locator("input[aria-label=\"Search sessions\"]").fill("albatross");
    await page.locator(".empty-state-title", { hasText: "No matches" }).waitFor({ timeout: 15_000 });
    await page.locator("input[aria-label=\"Search sessions\"]").fill(RARE);
    await hit.click();
    await page.waitForSelector(`text=${REPLY}`, { timeout: 15_000 });

    // A slow turn runs while Work is open, then lands in Finished since nobody looked.
    await input.fill("SLOW tide");
    await input.press("Enter");
    await until("the slow turn to start", async () => (await send.getAttribute("data-mode")) !== "send");
    await openPage("work");
    await page.locator("section[data-bucket=\"running\"]").locator(".list-row").first().waitFor({ timeout: 15_000 });
    await page.locator("section[data-bucket=\"finished\"]").locator(".list-row").first()
        .waitFor({ timeout: 30_000 });

    // The sidebar group title opens the folder's Workspace page.
    await page.locator(".group-title", { hasText: "nest" }).first().click();
    await page.waitForSelector("main[data-page=\"workspace\"]", { timeout: 10_000 });
    const sessions = await page.locator(".stat", { hasText: "Sessions" }).locator(".stat-value").innerText();
    if (sessions.trim() !== "1") throw new Error(`Workspace counted ${sessions} sessions`);
    await page.getByRole("button", { name: "New chat here" }).click();
    await page.waitForSelector("main[data-page=\"home\"] .context-chips .chip-label:text-is(\"nest\")", { timeout: 10_000 });

    // Devices describes this machine and nothing else.
    await openPage("devices");
    await page.locator(".list-row-title", { hasText: "This Mac" }).click();
    await page.locator(".device-state", { hasText: "Connected" }).waitFor({ timeout: 10_000 });
    console.log("pages e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
