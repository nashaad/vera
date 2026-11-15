// Theme import test for the desktop shell. Run with: node clients/desktop/test/themes.e2e.mjs
// The file picker and the installed VS Code extensions are fixtures. The importer is an included desktop extension
// that runs as a process named "Vera Theme Import", one per request.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COUNT_PROCESSES, MODIFIER, press, startTrial } from "./trial.mjs";

const trial = startTrial();
const files = join(trial.trialRoot, "files");
const fakeHome = join(trial.trialRoot, "fake-home");
const desktopFolder = join(trial.home, "machine", "desktop");
const extensionsFolder = join(desktopFolder, "extensions");
const IMPORTER = "vera.vscode-theme-import";
const IMPORT_COMMAND = `${IMPORTER}.import`;
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
    if (withImport) await page.locator("[data-theme-import=\"file\"]").waitFor({ timeout: 10_000 });
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

try {
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
        await page.locator("[data-theme-import=\"file\"]").click();
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
    await page.locator("[data-theme-import=\"file\"]").click();
    let refusal = await note(page, false);
    if (!refusal.includes("The file is not valid JSON") || !refusal.endsWith("Your theme is unchanged.")) throw new Error(`Unexpected refusal: ${refusal}`);
    expectEqual((await themeState(page)).theme, "imported:pirate-crow", "the theme after a broken file");
    await chosenFile(app, join(files, "bare.json"));
    await page.locator("[data-theme-import=\"file\"]").click();
    await until("the second refusal", async () => (await note(page, false)).includes("sets none of the colors Vera reads"));
    expectEqual((await themeState(page)).theme, "imported:pirate-crow", "the theme after a file with no mapped colors");
    expectEqual(readdirSync(extensionsFolder).join(","), "imported.pirate-crow", "the extensions folder after refusals");

    // A closed picker changes nothing.
    await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.locator("[data-theme-import=\"file\"]").click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expectEqual((await themeState(page)).theme, "imported:pirate-crow", "the theme after a closed picker");

    // Importing again replaces the file rather than adding another.
    write(join(files, "pirate-crow.json"), { ...PIRATE_CROW, colors: { ...PIRATE_CROW.colors, "editor.background": "#202830" } });
    await chosenFile(app, join(files, "pirate-crow.json"));
    await timed(async () => {
        await page.locator("[data-theme-import=\"file\"]").click();
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

    // A theme of an installed VS Code extension imports from the list.
    await page.locator("[data-theme-import=\"installed\"]").click();
    await page.locator("[data-installed-theme=\"Crow Hold Night\"]").waitFor({ timeout: 15_000 });
    await importProcessGone(app, 6);
    await page.locator("[data-installed-theme=\"Crow Hold Night\"]").click();
    await until("the installed theme", async () => (await themeState(page)).theme === "imported:crow-hold-night");
    expectEqual((await themeState(page)).surface, "rgb(27, 42, 31)", "the installed theme's surface");
    const source = JSON.parse(readFileSync(savedThemeFile("crow-hold-night"), "utf8")).source;
    expectEqual(source, "Extension Crow Hold", "the installed theme's source");
    await importProcessGone(app, 7);

    // Each imported theme is an installed extension of its own, listed beside the included importer.
    await openCustomize(page);
    await page.locator("[data-desktop-extension=\"imported.pirate-crow\"]").waitFor({ timeout: 10_000 });
    await page.locator("[data-desktop-extension=\"imported.crow-hold-night\"]").waitFor({ timeout: 10_000 });
    await page.locator(`[data-desktop-extension="${IMPORTER}"]`).waitFor({ timeout: 10_000 });
    expectEqual(await page.locator(`[data-desktop-extension-remove="${IMPORTER}"]`).count(), 0, "the remove button of the importer");
    expectEqual(await page.locator("[data-desktop-extension-remove=\"imported.pirate-crow\"]").count(), 1, "the remove button of an imported theme");

    // Turning the importer off takes away the command, its menu and palette entries and the import controls, and
    // a request that still reaches the shell is refused without starting a process. The imported themes stay.
    await page.locator(`[data-desktop-extension-switch="${IMPORTER}"]`).click();
    await page.locator(`[data-desktop-extension="${IMPORTER}"][data-enabled="false"]`).waitFor({ timeout: 5_000 });
    await until("the import item to leave the Theme menu", async () => !(await menuItem(app, IMPORT_COMMAND)));
    await openAppearance(app, page, false);
    await page.locator("[data-theme-card=\"imported:crow-hold-night\"]").waitFor({ timeout: 10_000 });
    expectEqual(await page.locator("[data-theme-import]").count(), 0, "the import controls while the importer is off");
    await press(app, "K", [MODIFIER]);
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("import vs code");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expectEqual(await page.locator(`.palette-row[data-command="${IMPORT_COMMAND}"]`).count(), 0, "the palette entry while the importer is off");
    await palette.press("Escape");
    expectEqual(
        JSON.stringify(await page.evaluate(() => window.veraDesktop.importTheme())),
        JSON.stringify({ ok: false, reason: "Vera could not import that theme." }),
        "a file import while the importer is off",
    );
    expectEqual(
        JSON.stringify(await page.evaluate(() => window.veraDesktop.listInstalledThemes())),
        JSON.stringify({ ok: false, reason: "Vera could not list the themes installed in VS Code." }),
        "the installed list while the importer is off",
    );
    await importProcessGone(app, 7);

    // Turning it on brings them all back.
    await openCustomize(page);
    await page.locator(`[data-desktop-extension-switch="${IMPORTER}"]`).click();
    await page.locator(`[data-desktop-extension="${IMPORTER}"][data-enabled="true"]`).waitFor({ timeout: 5_000 });
    await until("the import item to return to the Theme menu", () => menuItem(app, IMPORT_COMMAND));
    await openAppearance(app, page);
    expectEqual(await page.locator("[data-theme-import]").count() > 0, true, "the import controls once the importer is on again");
    await press(app, "K", [MODIFIER]);
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("import vs code");
    await page.locator(`.palette-row[data-command="${IMPORT_COMMAND}"]`).waitFor({ timeout: 10_000 });
    await palette.press("Escape");
    await importProcessGone(app, 7);

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
