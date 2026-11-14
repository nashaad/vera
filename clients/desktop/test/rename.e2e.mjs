// Rename test for the desktop. Run with: node clients/desktop/test/rename.e2e.mjs
// Renames an open session from the composer and from the row menu, and checks the sidebar row and the title bar
// show the new name within one host listing poll, with no turn in between. Runs off screen.

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const REPLY = "Crows sail past the reef.";
// The sidebar polls the host every 3 s; the margin covers the listing's round trip and the render.
const ONE_POLL_MS = 3_000 + 1_000;
const IDENTITY_NAME = /^[a-z]+-[a-z]+:[0-9a-f]{4}$/;

let turns = 0;

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
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
                usage,
            }));
            return;
        }
        turns += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, { content: REPLY }));
        response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    const input = page.locator(".composer-input");
    await input.fill("Hello crow");
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.getByText(REPLY).waitFor({ timeout: 30_000 });

    const agentId = await page.locator(".transcript-scroll").getAttribute("data-session");
    const rowName = page.locator(`.session-row[data-session="${agentId}"] .session-name`);
    const barTitle = page.locator(".titlebar-title");

    // A session with a title is labelled by it, never by its minted identity. The auto title is the provider's
    // non-streamed reply, which is this test's fixed sentence without its full stop.
    const AUTO_TITLE = REPLY.replace(/\.$/, "");
    await until("the row and the title bar to show the title", async () => (await rowName.innerText().catch(() => "")) === AUTO_TITLE && (await barTitle.innerText()) === AUTO_TITLE, 15_000);
    if (IDENTITY_NAME.test(await rowName.innerText())) throw new Error("The row shows the minted identity, not the title.");

    const turnsBefore = turns;
    const shows = async (name) => (await rowName.innerText()) === name && (await barTitle.innerText()) === name;
    const showsWithinOnePoll = async (name, how) => {
        await until(`the row and the title bar to show "${name}" after ${how}`, () => shows(name), ONE_POLL_MS);
    };

    // Rename from the composer.
    await input.fill("/rename Crow nest audit");
    await input.press("Enter");
    await page.getByText("Renamed to Crow nest audit").waitFor({ timeout: 15_000 });
    await showsWithinOnePoll("Crow nest audit", "/rename");

    // Rename from the row menu; the sheet starts from the name the row shows.
    const item = page.locator(`.session-item:has(.session-row[data-session="${agentId}"])`);
    await item.hover();
    await item.locator(".session-more").click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const field = page.getByRole("textbox", { name: "Session name" });
    await field.waitFor({ timeout: 10_000 });
    const start = await field.inputValue();
    if (start !== "Crow nest audit") throw new Error(`The rename sheet started from "${start}", not the name the row shows.`);
    await field.fill("Crow roost review");
    await field.press("Enter");
    await page.getByText("Renamed to Crow roost review").waitFor({ timeout: 15_000 });
    await showsWithinOnePoll("Crow roost review", "the rename sheet");

    if (turns !== turnsBefore) throw new Error("A turn ran between the renames, so the poll did not carry them.");
    console.log("rename e2e passed");
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
