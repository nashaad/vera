// Chat test for the desktop shell. Run with: node clients/desktop/test/chat.e2e.mjs
// A chat is a session with no folder of its own choosing; the host gives it a folder under the home.

import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const REPLY = "Crows sail past the reef.";
const LONG_TIMEOUT = 45_000;

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
        response.writeHead(200, { "content-type": "text/event-stream" });
        let closed = false;
        response.on("close", () => { closed = true; });
        for (const part of REPLY.split(/(?= )/)) {
            if (closed) return;
            response.write(streamChunk(body.model, { content: part }));
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        if (closed) return;
        response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
});

// The first prompt of a session is a heading, later ones are bubbles.
const USER = ":is(.user-turn, .user-bubble)";
const chipLabel = (name) => `.context-chips .chip-label:text-is("${name}")`;

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const folders = join(trial.home, "..", "folders");
    const vanished = join(folders, "vanished");
    const kept = join(folders, "kept");
    const doomed = join(folders, "doomed");
    for (const folder of [vanished, kept, doomed]) mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    // The native folder picker answers with whichever folder the test sets last.
    await app.evaluate(({ dialog }) => {
        globalThis.nextFolder = "";
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.nextFolder] });
    });
    const pickFolder = async (folder) => {
        await app.evaluate((_, path) => { globalThis.nextFolder = path; }, folder);
        await page.locator(".context-chips").getByRole("button", { name: /No folder|vanished|kept|doomed/ }).click();
        await page.getByRole("menuitem", { name: /Open folder/ }).click();
    };

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: LONG_TIMEOUT });
    await trial.waitForHost();

    const input = page.locator(".composer-input");
    const startSession = async (text) => {
        await input.fill(text);
        await input.press("Enter");
        await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: LONG_TIMEOUT });
        await page.waitForSelector(`${USER}:text-is("${text}")`, { timeout: 30_000 });
        await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });
    };
    const attachedId = async () => page.locator("[data-session][data-phase=\"attached\"]").first().getAttribute("data-session");
    const openFromSidebar = async (id) => {
        await page.click(`.session-row[data-session="${id}"]`);
        await page.waitForSelector(`[data-session="${id}"][data-phase="attached"]`, { timeout: LONG_TIMEOUT });
    };
    const newChat = async () => {
        await page.click(".nav-row[data-page=\"home\"]");
        await page.waitForSelector("main[data-page=\"home\"]");
    };

    // Two sessions in folders; one folder is then removed from disk.
    await page.waitForSelector(chipLabel("No folder"));
    await pickFolder(vanished);
    await page.waitForSelector(chipLabel("vanished"));
    await startSession("Hello vanished");
    const vanishedId = await attachedId();
    await newChat();
    await pickFolder(kept);
    await page.waitForSelector(chipLabel("kept"));
    await startSession("Hello kept");
    const keptId = await attachedId();
    // The host lists the folder by its real path, which differs from the temp path where /var is a link.
    const vanishedPath = realpathSync(vanished);
    rmSync(vanished, { recursive: true, force: true });

    // Opening the session whose folder was removed says so: the chip keeps the name and the notice gives the path.
    await openFromSidebar(vanishedId);
    const missingChip = page.locator(".context-chips .chip[data-missing=\"true\"]");
    await missingChip.waitFor();
    if ((await missingChip.getAttribute("title")) !== "Folder missing") throw new Error("The missing chip has the wrong title.");
    if ((await missingChip.innerText()).trim() !== "vanished") throw new Error("The missing chip lost the folder name.");
    await page.waitForSelector(`.composer-notice[data-tone="warning"]:text-is("The folder ${vanishedPath} no longer exists.")`);

    // A folder that exists shows no warning; the check runs again when the window is focused.
    await openFromSidebar(keptId);
    await page.waitForSelector(chipLabel("kept"));
    if (await missingChip.count() !== 0) throw new Error("A folder that exists is shown as missing.");
    rmSync(kept, { recursive: true, force: true });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await missingChip.waitFor();
    mkdirSync(kept, { recursive: true });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await missingChip.waitFor({ state: "detached" });

    // New Chat starts with no folder. The menu offers the folder that still exists, not the removed one.
    await newChat();
    await page.waitForSelector(chipLabel("No folder"));
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /kept/ }).waitFor();
    if (await page.locator(".folder-item-name:text-is(\"vanished\")").count() !== 0) throw new Error("The removed folder is still offered.");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".folder-menu", { state: "detached" });
    await page.waitForSelector(chipLabel("No folder"));

    // Typing and Enter with no folder starts a chat.
    await startSession("Hello chat");
    await page.waitForSelector(chipLabel("Chat"));
    const agentId = await attachedId();
    const chatsGroup = page.locator(".session-group:has(.group-title:text-is(\"Chats\"))");
    await chatsGroup.locator(`.session-row[data-session="${agentId}"]`).waitFor();
    if (await page.locator(".session-group").count() !== 3) throw new Error("Expected the Chats group beside two folder groups.");
    const files = join(trial.home, "runtime", "sessions", `${agentId}.jsonl.files`);
    await until("the chat's own folder", async () => existsSync(files) && statSync(files).isDirectory());

    // A failed create reads as an error and keeps what was typed.
    await newChat();
    await pickFolder(doomed);
    await page.waitForSelector(chipLabel("doomed"));
    rmSync(doomed, { recursive: true, force: true });
    await input.fill("Hello doomed");
    await input.press("Enter");
    const alert = page.locator(".composer-notice[role=\"alert\"]");
    await alert.waitFor({ timeout: 30_000 });
    if ((await input.inputValue()) !== "Hello doomed") throw new Error("The typed text was not kept.");
    console.log("chat e2e passed");
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
