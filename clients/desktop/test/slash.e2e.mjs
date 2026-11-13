// Slash command test for the desktop composer. Run with: node clients/desktop/test/slash.e2e.mjs
// A local provider streams a fixed reply; a skill in the trial home is invoked from the menu.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const REPLY = "Crows sail past the reef.";
const SKILL = "scout-the-field";
const SKILL_MARKER = "Count the crows on the north fence";

const requests = [];

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
        requests.push(JSON.stringify(body.messages ?? []));
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
    const skillFolder = join(trial.home, "skills", SKILL);
    mkdirSync(skillFolder, { recursive: true });
    writeFileSync(join(skillFolder, "SKILL.md"), `---\nname: ${SKILL}\ndescription: Count the crows on a field\n---\n\n${SKILL_MARKER}, then report the number.\n`);
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
    const menu = page.locator(".slash-menu");
    const notice = page.locator(".composer-notice");
    const option = (name) => page.locator(`.slash-item:has(.slash-name:text-is("/${name}"))`);

    // New Chat lists the built-in commands, marks the ones the window cannot run, and runs none of them as a message.
    await input.fill("/");
    await menu.waitFor();
    const groups = await page.locator(".slash-group").allInnerTexts();
    if (groups.join() !== "Built in") throw new Error(`New Chat showed the groups ${groups.join(", ")}.`);
    await option("import").locator(".slash-tag:text-is(\"Not implemented yet\")").waitFor();
    await input.fill("/imp");
    await until("the menu to narrow", async () => (await page.locator(".slash-item").count()) === 1);
    await input.press("Enter");
    await notice.filter({ hasText: "/import: Not implemented yet" }).waitFor();
    if ((await input.inputValue()) !== "") throw new Error("A not implemented command left its text in the box.");
    await input.fill("/modle");
    await input.press("Space");
    await input.press("Enter");
    await notice.filter({ hasText: "Unknown command: /modle. Did you mean /model?" }).waitFor();
    if ((await input.inputValue()) !== "/modle ") throw new Error("An unknown command did not keep its text.");
    if (requests.length > 0 || (await page.locator("[data-session]").count()) > 0) throw new Error("A slash line was sent as a message.");

    // Start a session so the host can answer for skills.
    await input.fill("Hello crow");
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 30_000 });

    // The menu groups built-ins and skills, sits above the box and outside the bar, and filters by prefix.
    await input.fill("/");
    await option(SKILL).waitFor({ timeout: 15_000 });
    const sessionGroups = await page.locator(".slash-group").allInnerTexts();
    if (sessionGroups.join() !== "Built in,Extensions,Skills") throw new Error(`The session showed the groups ${sessionGroups.join(", ")}.`);
    if (await page.locator(".composer-bar .slash-menu").count() > 0) throw new Error("The menu is inside the composer bar.");
    const placement = () => page.evaluate(() => {
        const rect = document.querySelector(".slash-menu").getBoundingClientRect();
        const box = document.querySelector(".composer").getBoundingClientRect();
        return {
            inside: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
            above: rect.bottom <= box.top + 1,
            fit: document.querySelector(".composer-bar").dataset.fit,
        };
    });
    let shown = await placement();
    if (!shown.inside || !shown.above) throw new Error(`The menu is misplaced: ${JSON.stringify(shown)}.`);
    await input.fill("/scout");
    await until("the menu to narrow to the skill", async () => (await page.locator(".slash-item").count()) === 1);

    // At the narrowest window the menu stays inside it and the bar keeps the fit it had.
    await input.fill("");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800));
    await page.waitForFunction(() => window.innerWidth <= 720, null, { timeout: 5_000 });
    const narrowFit = await page.locator(".composer-bar").getAttribute("data-fit");
    await input.fill("/");
    await menu.waitFor();
    shown = await placement();
    if (!shown.inside || !shown.above) throw new Error(`The menu is misplaced at the narrow width: ${JSON.stringify(shown)}.`);
    if (shown.fit !== narrowFit) throw new Error(`The menu changed the bar's fit from ${narrowFit} to ${shown.fit}.`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 800));
    await page.waitForFunction(() => window.innerWidth >= 1500, null, { timeout: 5_000 });

    // Escape closes the menu and keeps the text; arrows move and Tab completes the name.
    await input.fill("/co");
    await menu.waitFor();
    await input.press("Escape");
    await menu.waitFor({ state: "detached" });
    if ((await input.inputValue()) !== "/co") throw new Error("Escape cleared the box.");
    await input.fill("/c");
    await menu.waitFor();
    const firstRow = await page.locator(".slash-item[data-focused=\"true\"] .slash-name").innerText();
    await input.press("ArrowDown");
    const secondRow = await page.locator(".slash-item[data-focused=\"true\"] .slash-name").innerText();
    if (firstRow === secondRow) throw new Error("ArrowDown did not move the highlight.");
    await input.press("Tab");
    if ((await input.inputValue()) !== `${secondRow} `) throw new Error(`Tab left "${await input.inputValue()}" in the box.`);

    // A built-in runs the window's own command: /subagents opens its sheet.
    await input.fill("/subagents");
    await input.press("Enter");
    await page.waitForSelector("[role=\"dialog\"]");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role=\"dialog\"]", { state: "detached" });
    if ((await input.inputValue()) !== "") throw new Error("A command left its text in the box.");

    // A command the window cannot run says so and sends nothing.
    const before = requests.length;
    await input.fill("/import some/file");
    await input.press("Enter");
    await notice.filter({ hasText: "/import: Not implemented yet" }).waitFor();
    if (requests.length !== before) throw new Error("A not implemented command reached the provider.");

    // An extension command runs through the host and its answer shows under the box.
    await input.fill("/budget");
    await input.press("Enter");
    await notice.filter({ hasText: "vera.budget/budget:" }).waitFor({ timeout: 15_000 });

    // A skill is invoked through the host, which sends its name and arguments to the model as the turn.
    await input.fill(`/${SKILL} the north corn`);
    await input.press("Enter");
    await until("the skill to reach the provider", async () => requests.slice(before).some((text) => {
        const last = JSON.parse(text).filter((message) => message.role === "user").at(-1);
        return last?.content === `/${SKILL} the north corn`;
    }));
    if ((await input.inputValue()) !== "") throw new Error("A skill left its text in the box.");

    // Rename with a name, then with none to open the sheet.
    await input.fill("/rename Crow's nest audit");
    await input.press("Enter");
    await page.getByText("Renamed to Crow's nest audit").waitFor({ timeout: 15_000 });
    await input.fill("/rename");
    await input.press("Enter");
    const field = page.getByRole("textbox", { name: "Session name" });
    await field.waitFor();
    if ((await field.inputValue()).length === 0) throw new Error("The rename sheet did not start from the current name.");
    await page.keyboard.press("Escape");
    await field.waitFor({ state: "detached" });
    await input.fill("/rename");
    await input.press("Enter");
    await field.fill("Crow's roost");
    await field.press("Enter");
    await page.getByText("Renamed to Crow's roost").waitFor({ timeout: 15_000 });
    await field.waitFor({ state: "detached" });

    // A session with no parent says so; clone opens a second session.
    await input.fill("/parent");
    await input.press("Enter");
    await page.getByText("This session has no parent").waitFor();
    const opened = await page.locator(".transcript-scroll").getAttribute("data-session");
    await input.fill("/clone");
    await input.press("Enter");
    await until("the clone's page", async () => {
        const current = await page.locator(".transcript-scroll").getAttribute("data-session").catch(() => opened);
        return current !== opened;
    });
    await page.waitForSelector(".transcript-scroll[data-phase=\"attached\"]", { timeout: 30_000 });
    await page.waitForSelector(".app[data-sessions=\"2\"]", { timeout: 30_000 });
    await page.getByText("Cloned the session").waitFor();

    // Close stops the session and goes to New Chat.
    await input.fill("/close");
    await input.press("Enter");
    await page.waitForSelector("main[data-page=\"home\"]", { timeout: 30_000 });
    await page.getByText("Session closed").waitFor();
    console.log("slash e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests.map((text) => text.slice(-200)));
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);
