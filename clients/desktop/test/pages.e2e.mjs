// Pages test for the desktop shell. Run with: node clients/desktop/test/pages.e2e.mjs
// One session says a rare word; Search finds it, Work shows a slow turn finishing
// while another page is open, the Workspace page counts the folder's sessions,
// Devices describes this machine, Plugins lists what the folder loads,
// and the command palette and shortcuts sheet open from their keys.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { setSidebarGrouping } from "./sidebar.mjs";
import { COUNT_PROCESSES, startTrial } from "./trial.mjs";

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

async function press(app, key, modifiers) {
    await app.evaluate(({ BrowserWindow }, { key, modifiers }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
    }, { key, modifiers });
}

async function openPage(kind) {
    await page.locator(`[data-page="${kind}"]`).first().click();
    await page.waitForSelector(`main[data-page="${kind}"]`, { timeout: 10_000 });
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    // Work waits for a second session under Auto; this run has one.
    trial.writeFlags({ work: "on" });
    const folder = join(trial.home, "..", "nest");
    mkdirSync(folder, { recursive: true });
    // Enough folder and home skills that each section shows six rows and its own See-more line.
    for (let index = 1; index <= 8; index += 1) {
        const name = `nest-skill-${index}`;
        const skillFolder = join(folder, ".vera", "skills", name);
        mkdirSync(skillFolder, { recursive: true });
        writeFileSync(join(skillFolder, "SKILL.md"), `---\nname: ${name}\ndescription: Checks nest part ${index}\n---\nCount the eggs.\n`);
    }
    for (let index = 1; index <= 7; index += 1) {
        const name = `home-skill-${index}`;
        const skillFolder = join(trial.home, "skills", name);
        mkdirSync(skillFolder, { recursive: true });
        writeFileSync(join(skillFolder, "SKILL.md"), `---\nname: ${name}\ndescription: Checks home part ${index}\n---\nCount the stones.\n`);
    }
    // A project rule gives the Instructions kind a row whose meta line is its path.
    mkdirSync(join(folder, ".vera", "rules"), { recursive: true });
    writeFileSync(join(folder, ".vera", "rules", "cli.md"), "Help is --help.\n");
    const pluginSource = join(trial.trialRoot, "plugin-source");
    mkdirSync(join(pluginSource, "skills", "sail"), { recursive: true });
    mkdirSync(join(pluginSource, "dev.vera", "agents"), { recursive: true });
    writeFileSync(join(pluginSource, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "crow-pack",
        version: "1.0.0",
    }));
    writeFileSync(join(pluginSource, "skills", "sail", "SKILL.md"), "---\nname: sail\ndescription: Sail the reef\n---\nSail.\n");
    writeFileSync(join(pluginSource, "dev.vera", "agents", "captain.md"), "---\ndescription: Navigate\n---\nNavigate.\n");
    execFileSync("bun", ["-e", 'import { installPlugin } from "./src/plugins/manager.ts"; installPlugin(process.argv[1]);', pluginSource], {
        env: { ...process.env, VERA_HOME: trial.home },
    });
    const offSource = join(trial.trialRoot, "off-source");
    mkdirSync(join(offSource, "skills", "rest"), { recursive: true });
    writeFileSync(join(offSource, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "off-pack",
        version: "1.0.0",
    }));
    writeFileSync(join(offSource, "skills", "rest", "SKILL.md"), "---\nname: rest\ndescription: Rest at the reef\n---\nRest.\n");
    execFileSync("bun", ["-e", 'import { installPlugin, setPluginEnabled } from "./src/plugins/manager.ts"; installPlugin(process.argv[1]); setPluginEnabled("off-pack", false);', offSource], {
        env: { ...process.env, VERA_HOME: trial.home },
    });
    const installSource = join(trial.trialRoot, "install-source");
    mkdirSync(join(installSource, "skills", "map"), { recursive: true });
    mkdirSync(join(installSource, "dev.vera", "agents"), { recursive: true });
    writeFileSync(join(installSource, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "gull-pack",
        version: "1.0.0",
        description: "Charts for the crew",
        commands: ["ignored"],
    }));
    writeFileSync(join(installSource, "skills", "map", "SKILL.md"), "---\nname: map\ndescription: >\n  Map the reef\n---\nMap.\n");
    writeFileSync(join(installSource, "dev.vera", "agents", "mate.md"), "---\ndescription: >\n  Chart the reef\ntools: [read]\n---\nChart.\n");
    writeFileSync(join(installSource, "mcp.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { charts: { type: "stdio", command: "node" } },
    }));
    const invalidSource = join(trial.trialRoot, "invalid-plugin");
    mkdirSync(invalidSource, { recursive: true });
    writeFileSync(join(invalidSource, "plugin.json"), "not json");
    const shots = join(process.cwd(), ".agent-notes", "plugins-task", "out");
    mkdirSync(shots, { recursive: true });

    const app = await trial.launch({ args: COUNT_PROCESSES });
    const installProcesses = () => app.evaluate(({ app }) => ({
        started: globalThis.utilityStarts["Vera Plugin Install"] ?? 0,
        running: app.getAppMetrics().filter((metric) => metric.name === "Vera Plugin Install").length,
    }));
    const installProcessGone = (started) => until("the plugin install process to stop", async () => {
        const processes = await installProcesses();
        return processes.started === started && processes.running === 0;
    });
    if ((await installProcesses()).started !== 0) throw new Error("Plugin install started at launch.");
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await setSidebarGrouping(page, "folder");
    await trial.waitForHost();

    await page.getByRole("button", { name: /No folder/ }).click();
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

    // Plugins reads the folder from the host and stacks what it finds by where it loads.
    await openPage("customize");
    await page.locator(".plugin-section").first().waitFor({ timeout: 20_000 });
    const sections = await page.locator(".plugin-section").evaluateAll((blocks) => blocks.map((block) => block.getAttribute("data-section")));
    if (sections.join(",") !== "folder,home,builtin") throw new Error(`Plugins stacks the sections ${sections.join(", ")}`);
    const sectionCounts = async () => Object.fromEntries(await page.locator("[data-plugin-section-count]").evaluateAll((counts) => counts.map((count) => [count.getAttribute("data-plugin-section-count"), count.textContent.trim()])));
    let counts = await sectionCounts();
    if (counts.folder !== "8" || counts.home !== "8" || counts.builtin !== "2") {
        throw new Error(`Plugins counts ${JSON.stringify(counts)}`);
    }
    const folderSection = page.locator(".plugin-section[data-section=\"folder\"]");
    const homeSection = page.locator(".plugin-section[data-section=\"home\"]");
    const builtinSection = page.locator(".plugin-section[data-section=\"builtin\"]");
    const note = (await folderSection.locator(".plugin-section-note").innerText()).trim();
    if (note !== "Loads only in nest") throw new Error(`In this folder says ${note}`);
    const picker = (await folderSection.locator(".customize-folder button").innerText()).trim();
    if (picker !== "nest") throw new Error(`The folder picker in In this folder says ${picker}`);
    await folderSection.locator(".plugin-row[data-name=\"nest-skill-1\"]").waitFor({ timeout: 10_000 });

    // Each section shows six rows; each names the rest in its own See line, which opens only that section.
    const rowCount = async (section) => section.locator(".plugin-row").count();
    if (await rowCount(folderSection) !== 6 || await rowCount(homeSection) !== 6) {
        throw new Error(`The sections show ${await rowCount(folderSection)} and ${await rowCount(homeSection)} rows`);
    }
    const folderMeta = (await folderSection.locator(".plugin-row[data-name=\"nest-skill-1\"] .plugin-row-meta").innerText()).trim();
    if (folderMeta !== "/nest-skill-1") throw new Error(`A folder skill row says ${folderMeta}`);
    const homeMeta = (await homeSection.locator(".plugin-row[data-name=\"home-skill-1\"] .plugin-row-meta").innerText()).trim();
    if (homeMeta !== "/home-skill-1") throw new Error(`A home skill row says ${homeMeta}`);

    // Built in starts collapsed and opens from its chevron, leaving the other sections alone.
    if (await builtinSection.locator(".plugin-row").count() !== 0) throw new Error("Built in starts open.");
    await builtinSection.locator("[data-plugin-section-toggle=\"builtin\"]").click();
    await builtinSection.locator(".plugin-row[data-kind=\"skills\"][data-name=\"vera-help\"]").waitFor({ timeout: 10_000 });
    if (await builtinSection.locator("[data-plugin-section-toggle=\"builtin\"]").getAttribute("aria-expanded") !== "true") {
        throw new Error("The Built in chevron does not say it is open.");
    }
    if (await rowCount(folderSection) !== 6) throw new Error("Opening Built in changed In this folder.");
    const folderSeeMore = folderSection.locator("[data-plugin-see-more=\"folder\"]");
    const folderMore = (await folderSeeMore.innerText()).trim();
    if (folderMore !== "See nest-skill-7 and nest-skill-8") throw new Error(`The folder See line says ${folderMore}`);
    await folderSeeMore.click();
    await until("the rest of the folder rows", async () => await rowCount(folderSection) === 8);
    if (await rowCount(homeSection) !== 6) throw new Error("The folder See line opened rows in Your home.");
    const homeSeeMore = homeSection.locator("[data-plugin-see-more=\"home\"]");
    const homeMore = (await homeSeeMore.innerText()).trim();
    if (!homeMore.startsWith("See ")) throw new Error(`The home See line says ${homeMore}`);
    await homeSeeMore.click();
    await until("the rest of the home rows", async () => await rowCount(homeSection) === 8);
    const sail = homeSection.locator('.plugin-row[data-name="sail"]');
    if (!(await sail.locator(".plugin-row-meta").innerText()).includes("From crow-pack")) throw new Error("The plugin skill lost its origin.");
    await sail.locator(".plugin-row-main").click();
    const pluginSkillSheet = page.locator('[data-overlay="plugin-detail"]');
    if (!(await pluginSkillSheet.locator(".plugin-sheet-meta").innerText()).includes("From crow-pack")) throw new Error("The plugin skill sheet lost its origin.");
    await pluginSkillSheet.locator("[data-plugin-menu]").click();
    if (await page.getByRole("menuitem", { name: "Open in editor" }).count() !== 0) throw new Error("A plugin skill offers editing.");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await pluginSkillSheet.waitFor({ state: "detached", timeout: 5_000 });

    // Search filters every section, opens Built in when it matches, and says so when nothing does.
    const search = page.locator("input[aria-label=\"Search skills\"]");
    await search.fill("skill-7");
    await until("the search to keep both matching sections", async () => (await page.locator(".plugin-section").count()) === 2);
    if (await page.locator(".plugin-section[data-section=\"builtin\"]").count() !== 0) throw new Error("Built in stayed while it had no match.");
    await search.fill("vera-help");
    await page.locator(".plugin-section[data-section=\"builtin\"] .plugin-row[data-name=\"vera-help\"]").waitFor({ timeout: 10_000 });
    await search.fill("albatross");
    await page.locator("[data-plugin-no-match]").waitFor({ timeout: 10_000 });
    if ((await page.locator("[data-plugin-no-match]").innerText()).trim() !== "No skills match “albatross”.") {
        throw new Error(`The no-match line says ${await page.locator("[data-plugin-no-match]").innerText()}`);
    }
    if (await page.locator(".plugin-section").count() !== 0) throw new Error("A section stayed while nothing matched.");
    await search.fill("sail");
    await homeSection.locator('.plugin-row[data-name="sail"]').waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(shots, "round7-skills.png") });
    await search.fill("");

    await page.locator('.plugins-kinds button[data-kind="plugins"]').click();
    if ((await page.locator(".plugins-kinds button").first().getAttribute("data-kind")) !== "plugins") throw new Error("Plugins is not the first kind.");
    const pluginRow = page.locator('.plugin-row[data-kind="plugins"][data-name="crow-pack"]');
    await pluginRow.waitFor({ timeout: 10_000 });
    if ((await page.locator(".plugin-section").count()) !== 1 || (await page.locator(".plugin-section").first().getAttribute("data-section")) !== "home") throw new Error("Plugin packages are not home-only.");
    if (!(await pluginRow.locator(".plugin-row-meta").innerText()).includes("skills:1")) throw new Error("The plugin parts summary is missing.");
    await page.locator('.plugin-row[data-name="off-pack"] .plugin-off', { hasText: "Off" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(shots, "round7-plugins.png") });
    await pluginRow.locator(".plugin-row-main").click();
    const packageSheet = page.locator('[data-overlay="plugin-detail"]');
    await packageSheet.waitFor({ timeout: 5_000 });
    for (const expected of ["sail", "captain", "Location", "State", "Parts", "vera plugin disable crow-pack", "vera plugin remove crow-pack", "/plugins"]) {
        if (!(await packageSheet.innerText()).includes(expected)) throw new Error(`The plugin sheet is missing ${expected}.`);
    }
    if (await packageSheet.locator('[role="switch"], [data-plugin-try], [data-plugin-tab]').count() !== 0) throw new Error("The plugin sheet offers a mutation or file tab.");
    await page.screenshot({ path: join(shots, "round7-plugin-sheet.png") });
    await packageSheet.locator("[data-plugin-menu]").click();
    const packageMenu = await page.locator('[role="menu"] .menu-item').allInnerTexts();
    if (packageMenu.length !== 2 || !packageMenu.includes("Copy path") || !packageMenu.includes(process.platform === "darwin" ? "Show in Finder" : "Open folder")) throw new Error(`Plugin menu: ${packageMenu}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await packageSheet.waitFor({ state: "detached", timeout: 5_000 });

    const setEnabled = (enabled) => execFileSync("bun", ["-e", 'import { setPluginEnabled } from "./src/plugins/manager.ts"; setPluginEnabled("crow-pack", process.argv[1] === "true");', String(enabled)], {
        env: { ...process.env, VERA_HOME: trial.home },
    });
    setEnabled(false);
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await pluginRow.locator(".plugin-off", { hasText: "Off" }).waitFor({ timeout: 15_000 });
    setEnabled(true);
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await until("the plugin to turn back on", async () => await pluginRow.count() === 1 && await pluginRow.locator(".plugin-off").count() === 0);

    // A picker cancellation and a refused token do not start a task or change the home.
    const registry = join(trial.home, "machine", "plugins.json");
    const beforeInstall = readFileSync(registry, "utf8");
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /Install from folder/ }).click();
    await until("the picker cancellation", async () => (await page.getByRole("button", { name: "Add", exact: true }).isEnabled()));
    const forged = await page.evaluate(() => window.veraDesktop.installPlugin("00000000-0000-0000-0000-000000000000"));
    if (forged.ok || (await installProcesses()).started !== 0 || readFileSync(registry, "utf8") !== beforeInstall) throw new Error("A cancelled or forged install changed the home.");

    // An invalid folder is refused without changing the home.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, invalidSource);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /Install from folder/ }).click();
    const refused = page.locator('[data-overlay="plugin-install-refused"]');
    await refused.waitFor({ timeout: 20_000 });
    if (!(await refused.locator('[role="alert"]').innerText()).includes("plugin.json")) throw new Error("The refusal did not show its reason.");
    if (await refused.getByRole("button", { name: "Install", exact: true }).count() !== 0) throw new Error("The refused preview offers Install.");
    await refused.locator(".session-sheet-foot").getByRole("button", { name: "Close", exact: true }).click();
    await refused.waitFor({ state: "detached", timeout: 5_000 });
    await installProcessGone(1);
    if (readFileSync(registry, "utf8") !== beforeInstall) throw new Error("A refused preview changed the home.");

    // Each real preview/install gets one short-lived utility process, never an idle one.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, installSource);
    const previewStarted = Date.now();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /Install from folder/ }).click();
    const preview = page.locator('[data-overlay="plugin-install"]');
    await preview.waitFor({ timeout: 20_000 });
    const previewMs = Date.now() - previewStarted;
    for (const expected of ["gull-pack", "MCP status", "ignored", "Restart the resident host"]) {
        if (!(await preview.innerText()).includes(expected)) throw new Error(`The install preview is missing ${expected}.`);
    }
    for (const [label, expected] of [["Version", "1.0.0"], ["Skills", "map"], ["Agents", "mate"], ["MCP servers", "charts"]]) {
        const value = preview.locator(".plugin-facts dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
        if (!(await value.innerText()).includes(expected)) throw new Error(`The ${label} preview is missing ${expected}.`);
    }
    if (await preview.locator(".plugin-note", { hasText: "Warning:" }).count() !== 0) throw new Error("The installer could not read a valid plugin component.");
    if (readFileSync(registry, "utf8") !== beforeInstall || existsSync(join(trial.home, "plugins", "gull-pack"))) throw new Error("The preview wrote to the home.");
    await installProcessGone(2);
    await page.screenshot({ path: join(shots, "round7-install-preview.png") });
    await preview.getByRole("button", { name: "Cancel", exact: true }).click();
    await preview.waitFor({ state: "detached", timeout: 5_000 });
    if (readFileSync(registry, "utf8") !== beforeInstall || existsSync(join(trial.home, "plugins", "gull-pack"))) throw new Error("Cancelling the preview changed the home.");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /Install from folder/ }).click();
    await preview.waitFor({ timeout: 20_000 });
    await installProcessGone(3);
    const installStarted = Date.now();
    await preview.getByRole("button", { name: "Install", exact: true }).click();
    await page.locator('[data-plugin-install-report="true"]', { hasText: "Installed gull-pack" }).waitFor({ timeout: 20_000 });
    const installMs = Date.now() - installStarted;
    await installProcessGone(4);
    await page.locator('.plugin-row[data-kind="plugins"][data-name="gull-pack"]').waitFor({ timeout: 15_000 });
    await page.locator('.plugins-kinds button[data-kind="skills"]').click();
    await search.fill("map");
    await page.locator('[data-section="home"] .plugin-row[data-name="map"] .plugin-row-meta', { hasText: "From gull-pack" }).waitFor({ timeout: 15_000 });
    await page.locator('.plugins-kinds button[data-kind="agents"]').click();
    const agentSearch = page.locator('input[aria-label="Search agents"]');
    await agentSearch.fill("mate");
    await page.locator('[data-section="home"] .plugin-row[data-name="mate"] .plugin-row-meta', { hasText: "From gull-pack" }).waitFor({ timeout: 15_000 });
    await agentSearch.fill("");
    console.log(`Vera Plugin Install request times: preview ${previewMs}ms, install ${installMs}ms`);

    // Instructions show the file's name, and the path is the meta line.
    await page.locator(".plugins-kinds button[data-kind=\"instructions\"]").click();
    await page.locator(".plugin-section[data-section=\"folder\"] .plugin-row[data-name=\".vera/rules/cli.md\"]").waitFor({ timeout: 20_000 });
    const instructionRow = page.locator(".plugin-row[data-name=\".vera/rules/cli.md\"]");
    const instructionName = (await instructionRow.locator(".plugin-row-name").innerText()).trim();
    if (instructionName !== "cli.md") throw new Error(`The instruction row is named ${instructionName}`);
    const instructionMeta = (await instructionRow.locator(".plugin-row-meta").innerText()).trim();
    if (instructionMeta !== ".vera/rules/cli.md") throw new Error(`The instruction row says ${instructionMeta}`);
    if (await page.locator(".plugin-section[data-section=\"builtin\"]").count() !== 0) throw new Error("Instructions shows an empty Built in.");
    await page.locator(".plugins-kinds button[data-kind=\"skills\"]").click();
    await builtinSection.locator("[data-plugin-section-toggle=\"builtin\"]").click();
    await page.locator(".plugin-row[data-kind=\"skills\"][data-name=\"vera-help\"]").waitFor({ timeout: 20_000 });

    // The sheet has the facts, both tabs, the menu and Try now.
    await page.locator(".plugin-row[data-name=\"vera-help\"] .plugin-row-main").click();
    const pluginSheet = page.locator("[data-overlay=\"plugin-detail\"]");
    await pluginSheet.waitFor({ timeout: 10_000 });
    await pluginSheet.locator("[data-plugin-tab=\"overview\"]").waitFor({ timeout: 5_000 });
    for (const fact of ["Location", "Scope", "Loads in", "Command", "Files"]) {
        if (await pluginSheet.locator(".plugin-facts dt").filter({ hasText: fact }).count() !== 1) throw new Error(`The facts do not include ${fact}.`);
    }
    await pluginSheet.locator("[data-plugin-tab=\"files\"]").click();
    await pluginSheet.locator(".plugin-file-path").waitFor({ timeout: 5_000 });
    await pluginSheet.locator("[data-plugin-file-view=\"source\"]").click();
    await pluginSheet.locator(".plugin-source").waitFor({ timeout: 5_000 });
    await pluginSheet.locator("[data-plugin-menu]").click();
    const menuItems = await page.locator("[role=\"menu\"] .menu-item").allInnerTexts();
    for (const item of ["Open in editor", process.platform === "darwin" ? "Show in Finder" : "Open folder", "Copy Markdown", "Copy path"]) {
        if (!menuItems.includes(item)) throw new Error(`The sheet menu does not offer ${item}: ${menuItems.join(", ")}`);
    }
    await page.keyboard.press("Escape");
    await page.locator("[role=\"menu\"]").waitFor({ state: "detached", timeout: 5_000 });

    // Try now opens a new chat with the command in the composer, not sent.
    await pluginSheet.locator("[data-plugin-try]").click();
    await page.waitForSelector("main[data-page=\"home\"]", { timeout: 10_000 });
    await until("the command in the new chat composer", async () => (await page.locator(".composer-input").inputValue()) === "/vera-help");

    // A build with no catalog address says so in Discover.
    await openPage("customize");
    await page.locator(".customize-seg button", { hasText: "Discover" }).click();
    await page.locator("[data-catalog-unavailable]", { hasText: "The catalog is not available in this build." }).waitFor({ timeout: 10_000 });

    // Coverage lists what the window does, and the Tour opens the session by its status.
    await openPage("tour");
    await page.locator(".page-head .ghost-btn", { hasText: "Coverage" }).click();
    await page.waitForSelector("main[data-page=\"coverage\"] .coverage-row", { timeout: 10_000 });
    await page.locator(".page-head .ghost-btn", { hasText: "Tour" }).click();
    const sessionCard = page.locator(".tour-card[data-card=\"completed\"]:not([disabled]), .tour-card[data-card=\"idle\"]:not([disabled])");
    await sessionCard.first().click({ timeout: 10_000 });
    await page.waitForSelector(`text=${REPLY}`, { timeout: 15_000 });

    // The command palette runs a command by name.
    const modifier = process.platform === "darwin" ? "meta" : "control";
    await press(app, "K", [modifier]);
    const palette = page.locator("input[aria-label=\"Command palette\"]");
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("settings");
    await page.locator(".palette-row[data-command=\"go.settings\"]").waitFor({ timeout: 10_000 });
    await palette.press("Enter");
    await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
    if (await page.locator("[data-overlay=\"palette\"]").count() !== 0) throw new Error("The palette stayed open after running a command.");

    // Settings > Data counts this home's sessions.
    await page.locator(".rail-row", { hasText: "Data" }).click();
    await page.locator(".setting", { hasText: "Desktop folder" }).waitFor({ timeout: 10_000 });
    await until("the session count", async () => /\b1\b/.test(await page.locator(".setting", { hasText: "Sessions" }).first().innerText()));

    // Settings > Keyboard and the shortcuts sheet list the palette's keys.
    await page.locator(".rail-row", { hasText: "Keyboard" }).click();
    await page.locator(".settings-col").getByText("Command Palette", { exact: true }).first().waitFor({ timeout: 10_000 });
    await press(app, "/", [modifier]);
    const sheet = page.locator("[data-overlay=\"shortcuts\"]");
    await sheet.getByText("Command Palette", { exact: true }).first().waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached", timeout: 10_000 });

    // Full access stays out of the approval menus until Settings > Approvals turns it on, and turning it on asks first.
    const approvalModes = async () => {
        await press(app, "N", [modifier]);
        const pill = page.locator(".home-composer .approval-picker .pill-button");
        await pill.waitFor({ timeout: 10_000 });
        await pill.click();
        await page.locator(".approval-menu").waitFor({ timeout: 5_000 });
        const names = await page.locator(".approval-menu .approval-item-name").allInnerTexts();
        await page.keyboard.press("Escape");
        await page.locator(".approval-menu").waitFor({ state: "detached", timeout: 5_000 });
        return names;
    };
    if ((await approvalModes()).includes("Full access")) throw new Error("New Chat offers Full access before it was turned on.");
    await press(app, ",", [modifier]);
    await page.locator(".rail-row", { hasText: "Approvals" }).click();
    const offer = page.getByRole("switch", { name: "Offer Full access" });
    await offer.waitFor({ timeout: 10_000 });
    if (await offer.getAttribute("aria-checked") !== "false") throw new Error("Offer Full access starts on.");
    await offer.click();
    const ask = page.locator(".setting-confirm");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await ask.waitFor({ state: "detached", timeout: 5_000 });
    if (await offer.getAttribute("aria-checked") !== "false") throw new Error("Cancel turned Full access on.");
    await offer.click();
    await ask.getByRole("button", { name: "Offer Full access" }).click();
    await until("Full access on", async () => await offer.getAttribute("aria-checked") === "true");
    if (!(await approvalModes()).includes("Full access")) throw new Error("New Chat does not offer Full access after it was turned on.");

    // Go to Session opens the session by name.
    await press(app, "P", [modifier]);
    const finder = page.locator("input[aria-label=\"Go to session\"]");
    await finder.waitFor({ timeout: 10_000 });
    await page.locator(".palette-row[data-session]").first().click();
    await page.waitForSelector(`text=${REPLY}`, { timeout: 15_000 });
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
