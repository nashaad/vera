// Move test for the desktop shell. Run with: node clients/desktop/test/move.e2e.mjs
// A chat writes a file into its own folder, then moves into a folder the native picker returns.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { setSidebarGrouping } from "./sidebar.mjs";
import { startTrial } from "./trial.mjs";

const REPLY = "The crow is settled.";
const LONG_TIMEOUT = 45_000;
const FILE = "crow.txt";
const COLLISION = "Some of this chat's files have the same names as files in that folder.";

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
        response.writeHead(200, { "content-type": "text/event-stream" });
        const messages = body.messages ?? [];
        const lastUser = messages.findLastIndex((message) => message.role === "user");
        const wantsWrite = JSON.stringify(messages[lastUser]?.content ?? "").includes("WRITE");
        const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
        if (wantsWrite && results === 0) {
            const call = { index: 0, id: "call-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: FILE, content: "caw\n" }) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        } else {
            response.write(streamChunk(body.model, { role: "assistant", content: REPLY }, "stop"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const folders = join(trial.home, "..", "folders");
    const taken = join(folders, "taken");
    const harbor = join(folders, "harbor");
    const haven = join(folders, "haven");
    for (const folder of [taken, harbor, haven]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(taken, FILE), "someone else's\n");

    const app = await trial.launch();
    // The native folder picker answers with whichever folder the test sets last, and records each call.
    await app.evaluate(({ dialog }) => {
        globalThis.nextFolder = "";
        globalThis.pickerCalls = 0;
        dialog.showOpenDialog = async () => {
            globalThis.pickerCalls += 1;
            return globalThis.nextFolder === "" ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [globalThis.nextFolder] };
        };
    });
    const answerWith = (folder) => app.evaluate((_, path) => { globalThis.nextFolder = path; }, folder);
    const pickerCalls = () => app.evaluate(() => globalThis.pickerCalls);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: LONG_TIMEOUT });
    await setSidebarGrouping(page, "folder");
    await trial.waitForHost();

    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");
    const alert = page.locator(".composer-notice[role=\"alert\"]");
    const moveFromChip = async () => {
        await page.locator(".context-chips").getByRole("button", { name: /Chat/ }).click();
        await page.getByRole("menuitem", { name: "Move to folder…" }).click();
    };

    // A chat with a file in its own folder.
    await input.fill("Write the file, WRITE it");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: LONG_TIMEOUT });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });
    await until("the turn to end", async () => (await send.getAttribute("data-mode")) === "send");
    const sessionId = await page.locator("[data-session][data-phase=\"attached\"]").first().getAttribute("data-session");
    const chatFiles = join(trial.home, "runtime", "sessions", `${sessionId}.jsonl.files`);
    await until("the chat's file", async () => existsSync(join(chatFiles, FILE)));
    await page.waitForSelector(".context-chips .chip-label:text-is(\"Chat\")");
    const chatsGroup = page.locator(".session-group:has(.group-title:text-is(\"Chats\"))");
    await chatsGroup.locator(`.session-row[data-session="${sessionId}"]`).waitFor();

    // Cancelling the picker changes nothing and shows nothing.
    await answerWith("");
    await moveFromChip();
    await until("the picker to open", async () => (await pickerCalls()) === 1);
    if (await alert.count() !== 0) throw new Error("Cancelling the picker showed a message.");
    if (!existsSync(join(chatFiles, FILE))) throw new Error("Cancelling the picker moved the file.");

    // A folder with a file of the same name is refused, and the chat stays where it was.
    await answerWith(taken);
    await moveFromChip();
    await page.waitForSelector(`.composer-notice[data-tone="danger"][role="alert"]:text-is("${COLLISION}")`);
    if (!existsSync(join(chatFiles, FILE))) throw new Error("A refused move took the file.");
    if (readFileSync(join(taken, FILE), "utf8") !== "someone else's\n") throw new Error("A refused move changed the other file.");
    await page.waitForSelector(".context-chips .chip-label:text-is(\"Chat\")");
    await chatsGroup.locator(`.session-row[data-session="${sessionId}"]`).waitFor();

    // An empty folder takes the file; the same pane attaches again, the row leaves Chats and the typed text stays.
    await input.fill("A draft");
    await answerWith(harbor);
    await moveFromChip();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"harbor\")", { timeout: LONG_TIMEOUT });
    await page.waitForSelector(`[data-session="${sessionId}"][data-phase="attached"]`, { timeout: LONG_TIMEOUT });
    await until("the file in the new folder", async () => existsSync(join(harbor, FILE)));
    if (readFileSync(join(harbor, FILE), "utf8") !== "caw\n") throw new Error("The moved file changed.");
    if (existsSync(join(chatFiles, FILE))) throw new Error("The file is still in the chat folder.");
    if (await alert.count() !== 0) throw new Error("A message stayed after a move that worked.");
    await until("the composer to take input again", async () => await input.isEnabled());
    if ((await input.inputValue()) !== "A draft") throw new Error("The typed text was lost in the move.");
    await input.fill("");
    await page.locator(".session-group:has(.group-title:text-is(\"harbor\"))")
        .locator(`.session-row[data-session="${sessionId}"]`).waitFor({ timeout: 15_000 });
    if (await chatsGroup.count() !== 0) throw new Error("The Chats group is still listed.");
    if (await page.locator(`.session-row[data-session="${sessionId}"]`).count() !== 1) throw new Error("The session has more than one row.");
    if (await page.locator("[data-session][data-phase=\"attached\"]").count() !== 1) throw new Error("More than one pane is attached.");
    // The chip of a session in a folder is a label, not a menu.
    if (await page.locator(".context-chips button.chip").count() !== 0) throw new Error("The folder chip is still a menu.");

    // The same session answers again after the move.
    await input.fill("Still here");
    await input.press("Enter");
    await page.waitForSelector(":is(.user-turn, .user-bubble):text-is(\"Still here\")", { timeout: 30_000 });
    await until("the second turn to end", async () => (await send.getAttribute("data-mode")) === "send");

    // A session whose folder is gone offers the same move beside the notice.
    const harborPath = realpathSync(harbor);
    rmSync(harbor, { recursive: true, force: true });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForSelector(`.composer-notice[data-tone="warning"]:text-is("The folder ${harborPath} no longer exists.")`);
    await answerWith(haven);
    await page.getByRole("button", { name: "Move to folder…" }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"haven\")", { timeout: LONG_TIMEOUT });
    await page.waitForSelector(`[data-session="${sessionId}"][data-phase="attached"]`, { timeout: LONG_TIMEOUT });
    if (await page.locator(".context-chips .chip[data-missing=\"true\"]").count() !== 0) throw new Error("The new folder is shown as missing.");
    if (await page.locator(".composer-notice[data-tone=\"warning\"]").count() !== 0) throw new Error("The missing-folder notice stayed.");
    await page.locator(".session-group:has(.group-title:text-is(\"haven\"))")
        .locator(`.session-row[data-session="${sessionId}"]`).waitFor({ timeout: 15_000 });
    if (await page.locator("[data-session][data-phase=\"attached\"]").count() !== 1) throw new Error("More than one pane is attached.");
    console.log("move e2e passed");
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
