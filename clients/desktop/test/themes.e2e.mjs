// Theme import test for the desktop shell. Run with: node clients/desktop/test/themes.e2e.mjs
// The file picker and the installed VS Code extensions are fixtures. The importer is an included desktop extension
// that runs as a process named "Vera Theme Import", one per request.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { configureFauxHome, streamChunk } from "./faux-home.mjs";
import { COUNT_PROCESSES, MODIFIER, press, startTrial } from "./trial.mjs";

const trial = startTrial();
const builtinTrial = startTrial();
const files = join(trial.trialRoot, "files");
const fakeHome = join(trial.trialRoot, "fake-home");
const desktopFolder = join(trial.home, "machine", "desktop");
const extensionsFolder = join(desktopFolder, "extensions");
const IMPORTER = "vera.vscode-theme-import";
const IMPORT_COMMAND = `${IMPORTER}.import`;
const INSTALLED_COMMAND = `${IMPORTER}.installed`;
const IMPORT_BUTTON = `[data-extension-command="${IMPORT_COMMAND}"]`;
const INSTALLED_BUTTON = `[data-extension-command="${INSTALLED_COMMAND}"]`;
const SERVICE = "Vera Theme Import";

// A theme saved by an import is an extension named imported.<slug> with its file under themes/.
function savedThemeFile(slug) {
    return join(extensionsFolder, `imported.${slug}`, "themes", `${slug}.json`);
}

const PIRATE_CROW = {
    name: "Pirate Crow",
    type: "dark",
    colors: {
        "editor.background": "#10131a",
        "sideBar.background": "#0c0f15",
        foreground: "#d7dae0",
        "button.background": "#c9a227",
    },
    tokenColors: [{ scope: "comment", settings: { foreground: "#5c6370" } }],
};

function write(path, value) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
}

function prepare() {
    // A disabled entry for the included importer is ignored, so every check below runs with one in the state file.
    write(join(desktopFolder, "extensions.json"), { version: 1, disabled: [IMPORTER] });
    write(join(files, "pirate-crow.json"), PIRATE_CROW);
    write(join(files, "broken.json"), "{ \"colors\": { ");
    write(join(files, "bare.json"), { name: "Bare Crow", colors: { "editor.findMatchBackground": "#ff0000" } });
    const extension = join(fakeHome, ".vscode", "extensions", "crow.crow-hold-1.0.0");
    write(join(extension, "package.json"), {
        name: "crow-hold",
        displayName: "Crow Hold",
        contributes: { themes: [{ label: "Crow Hold Night", uiTheme: "vs-dark", path: "./themes/night.json" }] },
    });
    write(join(extension, "themes", "night.json"), {
        colors: { "editor.background": "#1b2a1f", "sideBar.background": "#14201a", foreground: "#e6f0e8" },
    });
}

async function until(label, check, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
}

async function boot() {
    const app = await trial.launch({ env: { HOME: fakeHome }, args: COUNT_PROCESSES });
    const page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();
    return { app, page };
}

function chosenFile(app, path) {
    return app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, path);
}

async function themeState(page) {
    return page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.background = "var(--vera-surface)";
        document.body.append(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { theme: document.documentElement.getAttribute("data-theme"), surface };
    });
}

async function openAppearance(app, page, withImport = true) {
    await press(app, "K", [MODIFIER]);
    const palette = page.locator("input[aria-label=\"Command palette\"]");
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("settings");
    await page.locator(".palette-row[data-command=\"go.settings\"]").waitFor({ timeout: 10_000 });
    await palette.press("Enter");
    await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
    await page.locator(".rail-row", { hasText: "Appearance" }).click();
    if (withImport) await page.locator(IMPORT_BUTTON).waitFor({ timeout: 10_000 });
    else await page.locator("[data-theme-card=\"dark\"]").waitFor({ timeout: 10_000 });
}

async function note(page, ok) {
    const locator = page.locator(`[data-import-ok="${ok}"]`);
    await locator.waitFor({ timeout: 10_000 });
    return locator.innerText();
}

// The import processes started since the app launched (counted by count-processes.cjs), and the ones running now.
function importProcesses(app) {
    return app.evaluate(({ app }) => ({
        started: globalThis.utilityStarts["Vera Theme Import"] ?? 0,
        running: app.getAppMetrics().filter((metric) => metric.name === "Vera Theme Import").length,
    }));
}

async function importProcessGone(app, started) {
    await until("the import process to stop", async () => {
        const processes = await importProcesses(app);
        return processes.started === started && processes.running === 0;
    });
}

const importTimes = [];

// Times one import from the click to the answer on the page.
async function timed(work) {
    const begin = performance.now();
    const result = await work();
    importTimes.push(performance.now() - begin);
    return result;
}

async function openCustomize(page) {
    await page.locator("[data-page=\"customize\"]").first().click();
    await page.waitForSelector("main[data-page=\"customize\"]", { timeout: 10_000 });
    await page.locator("[data-desktop-extension-install]").waitFor({ timeout: 10_000 });
}

function menuItem(app, id) {
    return app.evaluate(({ Menu }, commandId) => Menu.getApplicationMenu().getMenuItemById(commandId) !== null, id);
}

function expectEqual(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}.`);
}

const BUILTIN_THEMES = [
    "dark", "light", "high-contrast", "default", "vera-purple", "muted-blue", "onyx", "palenight",
    "synthwave", "nightowl", "github", "midnight-blue", "midnight-blue-ii", "norton-commander",
    "nc-navy", "windows-31", "vera-orange",
];
const CONTACT_SHEET = process.env.VERA_DESKTOP_THEME_CONTACT_SHEET ?? join(builtinTrial.trialRoot, "desktop-themes.png");

async function builtinJourney() {
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
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(`${streamChunk(body.model, { role: "assistant", content: "The crow settles on the branch." })}${streamChunk(body.model, {}, "stop")}data: [DONE]\n\n`);
        });
    });
    const shots = [];
    const hostPids = new Set();
    async function ready(app) {
        const page = await app.firstWindow();
        // First-paint colors precede boot; closing here can leave a detached host still starting.
        await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
        hostPids.add(await builtinTrial.waitForHost());
        return page;
    }
    let app;
    try {
        await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
        configureFauxHome(builtinTrial.home, provider.address().port, "auto");
        const extension = join(builtinTrial.home, "machine", "desktop", "extensions", "crow");
        write(join(extension, "vera.desktop.json"), {
            id: "crow",
            version: "1.0.0",
            engine: "vera-gui@^1",
            contributes: { themes: [{ label: "Onyx", path: "./themes/onyx.json" }] },
        });
        write(join(extension, "themes", "onyx.json"), {
            version: 1,
            slug: "onyx",
            name: "Onyx",
            type: "dark",
            source: "Extension Crow Onyx",
            colors: { surface: "#101820", "surface-sidebar": "#0b1118", text: "#e0e5eb" },
            values: {},
            tokenColors: [],
            semanticTokenColors: {},
        });
        app = await builtinTrial.launch();
        const page = await ready(app);
        await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
        await page.locator(".composer-input").fill("Say hello to the crow");
        await page.locator(".composer-input").press("Enter");
        await page.getByText("The crow settles on the branch.").waitFor({ timeout: 45_000 });
        await page.locator(".session-row").first().click();

        async function colorState() {
            return page.evaluate(() => {
                const style = getComputedStyle(document.documentElement);
                const colors = ["surface", "surface-sidebar", "surface-panel", "accent", "text", "border"]
                    .map((token) => style.getPropertyValue(`--vera-${token}`).trim());
                return { theme: document.documentElement.getAttribute("data-theme"), colors };
            });
        }

        async function selectTheme(name, action) {
            const before = await colorState();
            await action();
            await until(`theme ${name}`, async () => (await colorState()).theme === name);
            const after = await colorState();
            if (JSON.stringify(after.colors) === JSON.stringify(before.colors)) throw new Error(`Theme ${name} did not change the resolved window colors.`);
        }

        async function capture(name) {
            const themeSheet = page.locator('[data-overlay="themes"]');
            if (await themeSheet.count() > 0) {
                await page.keyboard.press("Escape");
                await themeSheet.waitFor({ state: "detached", timeout: 5_000 });
            }
            await page.locator(".session-row").first().click();
            const transcript = page.locator(".transcript-scroll").first();
            await transcript.waitFor({ timeout: 10_000 });
            await until(`the real conversation for ${name}`, async () => (await transcript.innerText()).includes("The crow settles on the branch."));
            const labels = JSON.parse(readFileSync(join(builtinTrial.root, "config", "tui-themes.json"), "utf8")).themes;
            const label = ({ dark: "Dark", light: "Light", "high-contrast": "High contrast" })[name] ?? labels[name]?.label ?? name;
            const path = join(builtinTrial.trialRoot, `${name}.png`);
            await page.screenshot({ path });
            shots.push({ name, label, path });
        }

        const menuChoice = "vera-purple";
        await selectTheme(menuChoice, () => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("theme.vera-purple").click()));
        await capture(menuChoice);

        await press(app, "K", [MODIFIER]);
        const palette = page.locator('input[aria-label="Command palette"]');
        await palette.waitFor({ timeout: 10_000 });
        await palette.fill("Theme: Muted Blue");
        await page.locator('.palette-row[data-command="theme.muted-blue"]').waitFor({ timeout: 10_000 });
        await selectTheme("muted-blue", () => palette.press("Enter"));
        await capture("muted-blue");

        await openAppearance(app, page, false);
        await page.locator('[data-theme-card="onyx"]').waitFor({ timeout: 10_000 });
        await selectTheme("onyx", () => page.locator('[data-theme-card="onyx"]').click());
        await capture("onyx");

        await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("theme.choose").click());
        const extensionState = await page.evaluate(() => window.veraDesktop.listDesktopExtensions());
        if (!extensionState.ok || !extensionState.themes.some((theme) => theme.slug === "crow.onyx")) {
            throw new Error(`The Onyx extension fixture was not loaded: ${JSON.stringify(extensionState)}`);
        }
        const onyxRows = page.locator('[data-overlay="themes"] [data-theme-name="onyx"]');
        await onyxRows.waitFor({ timeout: 10_000 });
        await page.locator('[data-overlay="themes"] [data-theme-name="imported:crow.onyx"]').waitFor({ timeout: 10_000 });
        const onyxText = await page.locator('[data-overlay="themes"]').innerText();
        if (!onyxText.includes("Onyx") || !onyxText.includes("Extension Crow Onyx")) throw new Error("The builtin and imported Onyx choices with extension source are not both visible in the theme sheet.");
        await page.locator('[data-overlay="themes"] [data-theme-name="imported:crow.onyx"]').click();
        await until("the imported Onyx collision choice", async () => (await colorState()).theme === "imported:crow.onyx");
        await page.locator('[data-overlay="themes"] [data-theme-name="onyx"]').click();
        await until("the builtin Onyx collision choice", async () => (await colorState()).theme === "onyx");
        await page.keyboard.press("Escape");
        const onyxMenuLabels = await app.evaluate(({ Menu }) => [
            Menu.getApplicationMenu().getMenuItemById("theme.onyx")?.label,
            Menu.getApplicationMenu().getMenuItemById("theme.imported.crow.onyx")?.label,
        ]);
        expectEqual(JSON.stringify(onyxMenuLabels), JSON.stringify(["Onyx", "Onyx"]), "the colliding Onyx menu labels");
        await press(app, "K", [MODIFIER]);
        const onyxPalette = page.locator('input[aria-label="Command palette"]');
        await onyxPalette.waitFor({ timeout: 10_000 });
        await onyxPalette.fill("Theme: Onyx");
        const builtinOnyxCommand = page.locator('.palette-row[data-command="theme.onyx"]');
        const importedOnyxCommand = page.locator('.palette-row[data-command="theme.imported.crow.onyx"]');
        await builtinOnyxCommand.waitFor({ timeout: 10_000 });
        await importedOnyxCommand.waitFor({ timeout: 10_000 });
        expectEqual(await builtinOnyxCommand.innerText(), "Theme: Onyx", "the builtin Onyx palette title");
        expectEqual(await importedOnyxCommand.innerText(), "Theme: Onyx", "the imported Onyx palette title");
        await onyxPalette.press("Escape");
        await openAppearance(app, page, false);
        const importedOnyxCard = page.locator('[data-theme-card="imported:crow.onyx"]');
        await importedOnyxCard.waitFor({ timeout: 10_000 });
        const builtinOnyxCard = page.locator('[data-theme-card="onyx"]');
        expectEqual(await builtinOnyxCard.count(), 1, "the builtin Onyx Appearance card");
        expectEqual(await importedOnyxCard.count(), 1, "the imported Onyx Appearance card");
        expectEqual(await builtinOnyxCard.innerText(), "Onyx", "the builtin Onyx Appearance label");
        expectEqual(await importedOnyxCard.innerText(), "Onyx", "the imported Onyx Appearance label");
        expectEqual(await importedOnyxCard.getAttribute("title"), "Extension Crow Onyx", "the imported Onyx Appearance source");
        await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("theme.choose").click());
        await page.locator('[data-overlay="themes"] [data-theme-name="palenight"]').waitFor({ timeout: 10_000 });
        await selectTheme("palenight", () => page.locator('[data-overlay="themes"] [data-theme-name="palenight"]').click());
        await capture("palenight");

        await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("go.tour").click());
        await page.waitForSelector('main[data-page="tour"]', { timeout: 10_000 });
        await selectTheme("synthwave", () => page.locator(".tour-select").selectOption("synthwave"));
        await capture("synthwave");

        for (const name of BUILTIN_THEMES) {
            if (shots.some((shot) => shot.name === name)) continue;
            await selectTheme(name, () => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), name === "high-contrast" ? "theme.highContrast" : `theme.${name}`));
            await capture(name);
        }

        await press(app, "K", [MODIFIER]);
        await palette.waitFor({ timeout: 10_000 });
        await palette.fill("Theme: High Contrast");
        const highContrast = page.locator('.palette-row[data-command="theme.highContrast"]');
        await highContrast.waitFor({ timeout: 10_000 });
        expectEqual(await highContrast.innerText(), "Theme: High Contrast", "the high contrast palette title");
        await palette.press("Escape");
        const require = createRequire(join(builtinTrial.root, "package.json"));
        const sharp = require("sharp");
        const width = 480;
        const height = 310;
        const columns = 3;
        const rows = Math.ceil(shots.length / columns);
        const composites = [];
        for (let index = 0; index < shots.length; index += 1) {
            const shot = shots[index];
            if (shot === undefined) continue;
            const left = (index % columns) * width;
            const top = Math.floor(index / columns) * height;
            const svg = `<svg width="${width}" height="36"><rect width="100%" height="100%" fill="#20242b"/><text x="12" y="24" fill="white" font-size="18" font-family="sans-serif">${shot.label}</text></svg>`;
            composites.push({ input: await sharp(shot.path).resize(width, height - 36, { fit: "contain", background: "#111" }).png().toBuffer(), left, top: top + 36 });
            composites.push({ input: Buffer.from(svg), left, top });
        }
        mkdirSync(join(CONTACT_SHEET, ".."), { recursive: true });
        await sharp({ create: { width: columns * width, height: rows * height, channels: 4, background: "#111" } }).composite(composites).png().toFile(CONTACT_SHEET);
        expectEqual(shots.length, BUILTIN_THEMES.length, "the captured builtin themes");

        await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("theme.vera-orange").click());
        await until("the stored vera-orange theme", async () => (await page.evaluate(() => localStorage.getItem("vera.theme"))) === "vera-orange");
        await app.close();
        app = await builtinTrial.launch();
        const relaunched = await ready(app);
        await until("the persisted builtin theme", async () => (await relaunched.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "vera-orange");
        await app.close();
        app = await builtinTrial.launch();
        const invalid = await ready(app);
        await invalid.evaluate(() => localStorage.setItem("vera.theme", "not-a-theme"));
        await app.close();
        app = await builtinTrial.launch();
        const fallback = await ready(app);
        await until("invalid theme fallback", async () => (await fallback.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark");
        console.log(`desktop builtin theme sheet: ${CONTACT_SHEET}`);
    } finally {
        await builtinTrial.cleanup();
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
        await until("the builtin trial hosts to exit", () => [...hostPids].every((pid) => {
            try {
                process.kill(pid, 0);
                return false;
            } catch (error) {
                if (error.code === "ESRCH") return true;
                throw error;
            }
        }));
        if (existsSync(builtinTrial.trialRoot)) throw new Error("The builtin trial home was not removed.");
        console.log(`builtin trial cleanup verified: hosts ${[...hostPids].join(", ")} exited; trial home removed`);
    }
}

try {
    await builtinJourney();
    prepare();
    const first = await boot();
    const { app, page } = first;
    expectEqual((await themeState(page)).theme, "dark", "the first launch theme");
    const darkSurface = (await themeState(page)).surface;
    // No import process runs at launch, and opening the page that holds the import controls starts none.
    await importProcessGone(app, 0);
    await openAppearance(app, page);
    await importProcessGone(app, 0);
    expectEqual(await menuItem(app, IMPORT_COMMAND), true, "the import item of the Theme menu while the importer is on");

    // A theme file imports through the picker and applies at once.
    await chosenFile(app, join(files, "pirate-crow.json"));
    const importNote = await timed(async () => {
        await page.locator(IMPORT_BUTTON).click();
        return note(page, true);
    });
    expectEqual(importNote, "Imported \"Pirate Crow\" and switched to it.", "the import note");
    let state = await themeState(page);
    expectEqual(state.theme, "imported:pirate-crow", "the theme after import");
    expectEqual(state.surface, "rgb(16, 19, 26)", "the mapped editor.background");
    await importProcessGone(app, 1);
    await page.locator("[data-theme-card=\"imported:pirate-crow\"][aria-pressed=\"true\"]").waitFor({ timeout: 5_000 });
    const saved = JSON.parse(readFileSync(savedThemeFile("pirate-crow"), "utf8"));
    expectEqual(saved.colors.accent, "#c9a227", "the saved accent");
    expectEqual(saved.tokenColors.length, 1, "the saved token rules");
    await until("the View menu to check the imported theme", () => app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu().getMenuItemById("theme.imported.pirate-crow");
        return item !== null && item.checked;
    }));

    // It sits beside the built-in themes and switches live in both directions.
    await page.locator("[data-theme-card=\"light\"]").click();
    await until("the light theme", async () => (await themeState(page)).theme === "light");
    if ((await themeState(page)).surface === state.surface) throw new Error("Light did not change the surface.");
    await page.locator("[data-theme-card=\"imported:pirate-crow\"]").click();
    await until("the imported theme again", async () => (await themeState(page)).theme === "imported:pirate-crow");
    expectEqual((await themeState(page)).surface, "rgb(16, 19, 26)", "the surface after switching back");

    // A file that does not parse, and one that sets none of the colors, are refused and the theme stays.
    await chosenFile(app, join(files, "broken.json"));
    await page.locator(IMPORT_BUTTON).click();
    let refusal = await note(page, false);
    if (!refusal.includes("The file is not valid JSON") || !refusal.endsWith("Your theme is unchanged.")) throw new Error(`Unexpected refusal: ${refusal}`);
    expectEqual((await themeState(page)).theme, "imported:pirate-crow", "the theme after a broken file");
    await chosenFile(app, join(files, "bare.json"));
    await page.locator(IMPORT_BUTTON).click();
    await until("the second refusal", async () => (await note(page, false)).includes("sets none of the colors Vera reads"));
    expectEqual((await themeState(page)).theme, "imported:pirate-crow", "the theme after a file with no mapped colors");
    expectEqual(readdirSync(extensionsFolder).join(","), "imported.pirate-crow", "the extensions folder after refusals");

    // A closed picker changes nothing.
    await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.locator(IMPORT_BUTTON).click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expectEqual((await themeState(page)).theme, "imported:pirate-crow", "the theme after a closed picker");

    // Importing again replaces the file rather than adding another.
    write(join(files, "pirate-crow.json"), { ...PIRATE_CROW, colors: { ...PIRATE_CROW.colors, "editor.background": "#202830" } });
    await chosenFile(app, join(files, "pirate-crow.json"));
    await timed(async () => {
        await page.locator(IMPORT_BUTTON).click();
        await until("the replaced colors", async () => (await themeState(page)).surface === "rgb(32, 40, 48)");
    });
    expectEqual(readdirSync(extensionsFolder).join(","), "imported.pirate-crow", "the extensions folder after a re-import");

    // The command palette lists the imported theme and the import command.
    await press(app, "K", [MODIFIER]);
    const palette = page.locator("input[aria-label=\"Command palette\"]");
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("pirate");
    await page.locator(".palette-row[data-command=\"theme.imported.pirate-crow\"]").waitFor({ timeout: 10_000 });
    await palette.fill("import vs code");
    await page.locator(`.palette-row[data-command="${IMPORT_COMMAND}"]`).waitFor({ timeout: 10_000 });
    await chosenFile(app, join(files, "pirate-crow.json"));
    await palette.press("Enter");
    await page.locator(".toast-text", { hasText: "Imported \"Pirate Crow\"" }).waitFor({ timeout: 10_000 });

    // The installed VS Code themes open as a list, and choosing one imports it. The list holds labels only: the paths
    // stay in the shell, which gets a key back.
    await timed(async () => {
        await page.locator(INSTALLED_BUTTON).click();
        await page.locator("[data-overlay=\"picker\"]").waitFor({ timeout: 15_000 });
    });
    await importProcessGone(app, 6);
    const listRow = page.locator(".palette-row[data-pick]", { hasText: "Crow Hold Night" });
    await listRow.waitFor({ timeout: 5_000 });
    expectEqual(await listRow.innerText().then((text) => text.includes("Crow Hold")), true, "the detail of the listed theme");
    const listHtml = await page.locator("[data-overlay=\"picker\"]").innerHTML();
    expectEqual(listHtml.includes(fakeHome) || listHtml.includes("night.json"), false, "a path in the list the window shows");
    await page.locator("[data-overlay=\"picker\"] input").fill("zzz");
    await page.locator("[data-overlay=\"picker\"] .palette-empty", { hasText: "No matches" }).waitFor({ timeout: 5_000 });
    const filter = page.locator("[data-overlay=\"picker\"] input");
    await filter.fill("hold");
    await filter.press("Enter");
    await until("the installed theme", async () => (await themeState(page)).theme === "imported:crow-hold-night");
    expectEqual((await themeState(page)).surface, "rgb(27, 42, 31)", "the installed theme's surface");
    expectEqual(await page.locator("[data-overlay=\"picker\"]").count(), 0, "the list after choosing");
    expectEqual(
        (await note(page, true)).startsWith("Imported \"Crow Hold Night\""),
        true,
        "the note after choosing an installed theme",
    );
    const source = JSON.parse(readFileSync(savedThemeFile("crow-hold-night"), "utf8")).source;
    expectEqual(source, "Extension Crow Hold", "the installed theme's source");
    await importProcessGone(app, 7);

    // A list can be closed with Escape and nothing is imported or started again.
    await page.locator(INSTALLED_BUTTON).click();
    await page.locator("[data-overlay=\"picker\"]").waitFor({ timeout: 15_000 });
    await importProcessGone(app, 8);
    await page.locator("[data-overlay=\"picker\"] input").press("Escape");
    await page.locator("[data-overlay=\"picker\"]").waitFor({ state: "detached", timeout: 5_000 });
    await importProcessGone(app, 8);

    // Each imported theme is an installed extension of its own. The included importer is not listed, so it has no
    // switch, and a request to turn it off is refused. The command, its menu and palette entries stay.
    await openCustomize(page);
    await page.locator("[data-desktop-extension=\"imported.pirate-crow\"]").waitFor({ timeout: 10_000 });
    await page.locator("[data-desktop-extension=\"imported.crow-hold-night\"]").waitFor({ timeout: 10_000 });
    expectEqual(await page.locator("[data-desktop-extension]").count(), 2, "the extensions listed");
    expectEqual(await page.locator(`[data-desktop-extension="${IMPORTER}"]`).count(), 0, "the rows of the importer");
    expectEqual(await page.locator(`[data-desktop-extension-switch="${IMPORTER}"]`).count(), 0, "the switches of the importer");
    expectEqual(await page.locator("[data-desktop-extension-remove=\"imported.pirate-crow\"]").count(), 1, "the remove button of an imported theme");
    const refused = await page.evaluate((id) => window.veraDesktop.setDesktopExtensionEnabled(id, false), IMPORTER);
    expectEqual(
        JSON.stringify(refused),
        JSON.stringify({ ok: false, reason: `Vera could not turn "${IMPORTER}" off.` }),
        "turning the importer off",
    );
    const listed = await page.evaluate(() => window.veraDesktop.listDesktopExtensions());
    const importer = listed.ok ? listed.extensions.find((entry) => entry.id === IMPORTER) : undefined;
    expectEqual(importer === undefined ? "missing" : `${importer.included}/${importer.enabled}`, "true/true", "the importer in the list the window reads");
    expectEqual(await menuItem(app, IMPORT_COMMAND), true, "the import item of the Theme menu");
    await openAppearance(app, page);
    expectEqual(await page.locator("[data-extension-command]").count(), 2, "the import controls");
    await press(app, "K", [MODIFIER]);
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("import vs code");
    await page.locator(`.palette-row[data-command="${IMPORT_COMMAND}"]`).waitFor({ timeout: 10_000 });
    await palette.press("Escape");
    await importProcessGone(app, 8);

    // The choice and its colors are there again after a relaunch on the same home.
    await app.close();
    const second = await boot();
    await importProcessGone(second.app, 0);
    await until("the remembered imported theme", async () => (await themeState(second.page)).theme === "imported:crow-hold-night");
    expectEqual((await themeState(second.page)).surface, "rgb(27, 42, 31)", "the surface after the relaunch");
    await until("the View menu to check the theme after the relaunch", () => second.app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu().getMenuItemById("theme.imported.crow-hold-night");
        return item !== null && item.checked;
    }));

    // A theme file removed from the home falls back to the default on the next launch.
    await second.app.close();
    writeFileSync(savedThemeFile("crow-hold-night"), "removed");
    const third = await boot();
    await until("the fallback", async () => (await themeState(third.page)).theme === "dark");
    expectEqual((await themeState(third.page)).surface, darkSurface, "the fallback surface");

    if (!existsSync(savedThemeFile("pirate-crow"))) throw new Error("The imported theme's file went missing.");
    if (existsSync(join(desktopFolder, "themes"))) throw new Error("An import wrote to the old themes folder.");
    const seconds = importTimes.map((time) => (time / 1000).toFixed(2)).join(", ");
    console.log(`themes e2e passed: ${trial.home} (import times ${seconds} s)`);
} finally {
    await trial.cleanup();
}
