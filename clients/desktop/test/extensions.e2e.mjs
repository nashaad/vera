// Desktop extension test for the desktop shell. Run with: node clients/desktop/test/extensions.e2e.mjs
// The file picker is a fixture. Packages are real gzip tar files made with the system tar.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeApp, MODIFIER, press, startTrial } from "./trial.mjs";

const trial = startTrial();
const files = join(trial.trialRoot, "files");
const desktopFolder = join(trial.home, "machine", "desktop");
const extensionsFolder = join(desktopFolder, "extensions");
const SERVICE = "Vera Extension Install";

const NIGHT = "#101820";
const DAY = "#f0e8d8";

function savedTheme(slug, name, type, surface) {
    return {
        version: 1,
        slug,
        name,
        type,
        source: "Extension crow.pack",
        colors: { surface },
        values: {},
        tokenColors: [],
        semanticTokenColors: {},
    };
}

function write(path, value) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
}

// A package is a gzip tar with its files at the archive root. ustar and no AppleDouble entries keep it plain.
function makePackage(name, version) {
    const folder = join(files, `${name}-src`);
    write(join(folder, "vera.desktop.json"), {
        id: "crow.pack",
        version,
        engine: "vera-gui@^1",
        contributes: {
            themes: [
                { label: "Crow Night", path: "themes/crow-night.json" },
                { label: "Crow Day", path: "themes/crow-day.json" },
            ],
        },
    });
    write(join(folder, "themes", "crow-night.json"), savedTheme("crow-night", "Crow Night", "dark", NIGHT));
    write(join(folder, "themes", "crow-day.json"), savedTheme("crow-day", "Crow Day", "light", DAY));
    const path = join(files, `${name}.tgz`);
    execFileSync("tar", ["--format", "ustar", "-czf", path, "-C", folder, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return path;
}

function prepare() {
    // A theme saved by an earlier version, which the app moves into an extension on its first start.
    write(
        join(desktopFolder, "themes", "legacy-crow.json"),
        savedTheme("legacy-crow", "Legacy Crow", "dark", "#202830"),
    );
    return {
        one: makePackage("crow-one", "1.0.0"),
        two: makePackage("crow-two", "1.1.0"),
        bad: write(join(files, "bad.tgz"), "this is not a gzip tar file"),
    };
}

async function until(label, check, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
}

async function boot() {
    const app = await trial.launch();
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
        return { theme: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("vera.theme"), surface };
    });
}

async function openCustomize(page) {
    await page.locator("[data-page=\"customize\"]").first().click();
    await page.waitForSelector("main[data-page=\"customize\"]", { timeout: 10_000 });
    await page.locator("[data-desktop-extension-install]").waitFor({ timeout: 10_000 });
}

async function openAppearance(app, page) {
    await press(app, "K", [MODIFIER]);
    const palette = page.locator("input[aria-label=\"Command palette\"]");
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("settings");
    await page.locator(".palette-row[data-command=\"go.settings\"]").waitFor({ timeout: 10_000 });
    await palette.press("Enter");
    await page.waitForSelector("main[data-page=\"settings\"]", { timeout: 10_000 });
    await page.locator(".rail-row", { hasText: "Appearance" }).click();
    await page.locator("[data-theme-card=\"dark\"]").waitFor({ timeout: 10_000 });
}

// Counts the install processes started since launch, and the ones still running.
async function watchInstallProcesses(app) {
    await app.evaluate(({ utilityProcess }, service) => {
        const fork = utilityProcess.fork.bind(utilityProcess);
        globalThis.extensionInstallStarts = 0;
        utilityProcess.fork = (modulePath, args, options) => {
            if (options?.serviceName === service) globalThis.extensionInstallStarts += 1;
            return fork(modulePath, args, options);
        };
    }, SERVICE);
}

function installProcesses(app) {
    return app.evaluate(({ app: electronApp }, service) => ({
        started: globalThis.extensionInstallStarts,
        running: electronApp.getAppMetrics().filter((metric) => metric.name === service).length,
    }), SERVICE);
}

async function installProcessGone(app, started) {
    await until("the install process to stop", async () => {
        const processes = await installProcesses(app);
        return processes.started === started && processes.running === 0;
    });
}

function expectEqual(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}.`);
}

function entries() {
    return existsSync(extensionsFolder) ? readdirSync(extensionsFolder).sort() : [];
}

// The installed extensions. A package that is unpacked but not installed sits in a folder named .staging-*.
function extensionFolders() {
    return entries().filter((name) => !name.startsWith(".staging-")).join(",");
}

function stagingFolders() {
    return entries().filter((name) => name.startsWith(".staging-")).length;
}

async function report(page, ok) {
    const locator = page.locator(`[data-desktop-extension-report="${ok}"]`);
    await locator.waitFor({ timeout: 10_000 });
    return locator.innerText();
}

// Chooses a package and waits for its preview, and returns the seconds from the click to the preview.
async function previewPackage(app, page, path, started) {
    await chosenFile(app, path);
    const clicked = Date.now();
    await page.locator("[data-desktop-extension-install]").click();
    await page.locator("[data-desktop-extension-preview]").waitFor({ timeout: 15_000 });
    const seconds = (Date.now() - clicked) / 1000;
    await installProcessGone(app, started);
    return seconds;
}

try {
    const packages = prepare();
    const first = await boot();
    const { app, page } = first;
    await watchInstallProcesses(app);
    await installProcessGone(app, 0);

    // The theme saved by an earlier version moved into an extension, and the old folder is gone.
    expectEqual(extensionFolders(), "imported.legacy-crow", "the extensions after the first start");
    if (existsSync(join(desktopFolder, "themes", "legacy-crow.json"))) throw new Error("The old theme file was left behind.");
    await openAppearance(app, page);
    await page.locator("[data-theme-card=\"imported:legacy-crow\"]").waitFor({ timeout: 10_000 });

    await openCustomize(page);
    await page.locator("[data-desktop-extension=\"imported.legacy-crow\"]").waitFor({ timeout: 10_000 });
    // The theme importer ships with the app, always on, so the list leaves it out and it has no switch to turn off.
    expectEqual(await page.locator("[data-desktop-extension]").count(), 1, "the extensions listed");
    expectEqual(await page.locator("[data-desktop-extension=\"vera.vscode-theme-import\"]").count(), 0, "the rows of the importer");
    expectEqual(await page.locator("[data-desktop-extension-switch=\"vera.vscode-theme-import\"]").count(), 0, "the switches of the importer");
    expectEqual((await page.locator("[data-desktop-extensions] .section-count").first().innerText()).trim(), "1", "the count of the extensions listed");

    // A package shows what it holds, and nothing is installed until it is confirmed.
    const previewSeconds = await previewPackage(app, page, packages.one, 1);
    const shown = await page.locator("[data-desktop-extension-preview]").innerText();
    for (const text of ["crow.pack", "1.0.0", "Themes: Crow Night, Crow Day"]) {
        if (!shown.includes(text)) throw new Error(`The preview does not show "${text}": ${shown}`);
    }
    expectEqual(extensionFolders(), "imported.legacy-crow", "the extensions while a package is previewed");
    expectEqual(stagingFolders(), 1, "the staging folders while a package is previewed");
    await page.locator("[data-desktop-extension-cancel]").click();
    await page.locator("[data-desktop-extension-preview]").waitFor({ state: "detached", timeout: 5_000 });
    expectEqual(extensionFolders(), "imported.legacy-crow", "the extensions after cancelling");
    await until("the staging folder to be removed", () => stagingFolders() === 0);

    // Confirming installs it, lists it and offers its themes.
    await previewPackage(app, page, packages.one, 2);
    await page.locator("[data-desktop-extension-confirm]").click();
    await page.locator("[data-desktop-extension=\"crow.pack\"]").waitFor({ timeout: 10_000 });
    expectEqual(await report(page, true), "Installed \"crow.pack\".", "the install note");
    expectEqual(extensionFolders(), "crow.pack,imported.legacy-crow", "the extensions after the install");
    expectEqual(stagingFolders(), 0, "the staging folders after the install");
    const manifest = JSON.parse(readFileSync(join(extensionsFolder, "crow.pack", "vera.desktop.json"), "utf8"));
    expectEqual(manifest.version, "1.0.0", "the installed version");
    await installProcessGone(app, 2);

    await openAppearance(app, page);
    await page.locator("[data-theme-card=\"imported:crow.pack.crow-night\"]").waitFor({ timeout: 10_000 });
    await page.locator("[data-theme-card=\"imported:crow.pack.crow-day\"]").waitFor({ timeout: 10_000 });
    await page.locator("[data-theme-card=\"imported:crow.pack.crow-night\"]").click();
    await until("the extension theme", async () => (await themeState(page)).theme === "imported:crow.pack.crow-night");
    expectEqual((await themeState(page)).surface, "rgb(16, 24, 32)", "the extension theme's surface");

    // Turning the extension off takes its themes away, and the window falls back to the built-in dark theme.
    await openCustomize(page);
    await page.locator("[data-desktop-extension-switch=\"crow.pack\"]").click();
    await until("the fallback after turning off", async () => (await themeState(page)).theme === "dark");
    expectEqual((await themeState(page)).stored, "dark", "the stored theme after turning off");
    await page.locator("[data-desktop-extension=\"crow.pack\"][data-enabled=\"false\"]").waitFor({ timeout: 5_000 });
    await openAppearance(app, page);
    expectEqual(await page.locator("[data-theme-card=\"imported:crow.pack.crow-night\"]").count(), 0, "the themes of an extension that is off");

    // Turning it on offers them again, without choosing one.
    await openCustomize(page);
    await page.locator("[data-desktop-extension-switch=\"crow.pack\"]").click();
    await page.locator("[data-desktop-extension=\"crow.pack\"][data-enabled=\"true\"]").waitFor({ timeout: 5_000 });
    await openAppearance(app, page);
    await page.locator("[data-theme-card=\"imported:crow.pack.crow-day\"]").waitFor({ timeout: 10_000 });
    expectEqual((await themeState(page)).theme, "dark", "the theme after turning back on");

    // A newer package replaces the installed one under the same id.
    await openCustomize(page);
    await previewPackage(app, page, packages.two, 3);
    const replacing = await page.locator("[data-desktop-extension-preview]").innerText();
    if (!replacing.includes("Replaces version 1.0.0.")) throw new Error(`The preview does not name what it replaces: ${replacing}`);
    await page.locator("[data-desktop-extension-confirm]").click();
    await until("the new version", async () => (await page.locator("[data-desktop-extension=\"crow.pack\"]").innerText()).includes("1.1.0"));
    expectEqual(extensionFolders(), "crow.pack,imported.legacy-crow", "the extensions after the replacement");

    // A file that is not a package is refused, and nothing is left behind.
    await chosenFile(app, packages.bad);
    await page.locator("[data-desktop-extension-install]").click();
    expectEqual(await report(page, false), "The package is not a gzip tar file.", "the refusal");
    await installProcessGone(app, 4);
    expectEqual(extensionFolders(), "crow.pack,imported.legacy-crow", "the extensions after a refusal");
    expectEqual(stagingFolders(), 0, "the staging folders after a refusal");

    // A closed picker changes nothing and starts no process.
    await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.locator("[data-desktop-extension-install]").click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await installProcessGone(app, 4);

    // The choice, and the extension, are there again after a relaunch on the same home.
    await openAppearance(app, page);
    await page.locator("[data-theme-card=\"imported:crow.pack.crow-night\"]").click();
    await until("the extension theme again", async () => (await themeState(page)).theme === "imported:crow.pack.crow-night");
    await closeApp(app);
    const second = await boot();
    await until("the remembered extension theme", async () => (await themeState(second.page)).theme === "imported:crow.pack.crow-night");
    expectEqual((await themeState(second.page)).surface, "rgb(16, 24, 32)", "the surface after the relaunch");
    await watchInstallProcesses(second.app);
    await installProcessGone(second.app, 0);

    // Removing the extension that owns the theme falls back to the built-in theme of the same type.
    await openCustomize(second.page);
    await second.page.locator("[data-desktop-extension-remove=\"crow.pack\"]").click();
    await second.page.locator("[data-desktop-extension=\"crow.pack\"]").waitFor({ state: "detached", timeout: 10_000 });
    await until("the fallback after the removal", async () => (await themeState(second.page)).theme === "dark");
    expectEqual(extensionFolders(), "imported.legacy-crow", "the extensions after the removal");
    expectEqual(await report(second.page, true), "Removed \"crow.pack\".", "the removal note");

    // A light theme falls back to the light built-in.
    await previewPackage(second.app, second.page, packages.one, 1);
    await second.page.locator("[data-desktop-extension-confirm]").click();
    await second.page.locator("[data-desktop-extension=\"crow.pack\"]").waitFor({ timeout: 10_000 });
    await openAppearance(second.app, second.page);
    await second.page.locator("[data-theme-card=\"imported:crow.pack.crow-day\"]").click();
    await until("the light extension theme", async () => (await themeState(second.page)).theme === "imported:crow.pack.crow-day");
    await openCustomize(second.page);
    await second.page.locator("[data-desktop-extension-remove=\"crow.pack\"]").click();
    await until("the light fallback", async () => (await themeState(second.page)).theme === "light");
    await installProcessGone(second.app, 1);

    if (existsSync(join(desktopFolder, "themes"))) throw new Error("The old themes folder came back.");
    console.log(`extensions e2e passed: ${trial.home} (preview ${previewSeconds.toFixed(2)} s)`);
} finally {
    await trial.cleanup();
}
