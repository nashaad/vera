// Walks the desktop app through its main flows in a visible window, against a throwaway home and a scripted provider.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { configureFauxHome } from "../test/faux-home.mjs";
import { startTrial } from "../test/trial.mjs";
import { startTourProvider } from "./provider.mjs";
import { writeSheet } from "./sheet.mjs";
import { steps } from "./steps.mjs";

const root = new URL("../../..", import.meta.url).pathname;
const FACTORY_CONFIG = join(root, "dev", "factory-home", "config.json");
const TREASURE = "# Treasure log\n\n- Gold doubloons: 12\n- Silver spoons: 4\n";

function parseArgs(argv) {
    const options = { keepOpen: false, real: false, pace: 700, out: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--keep-open") {
            options.keepOpen = true;
        } else if (arg === "--real") {
            options.real = true;
        } else if (arg === "--pace" || arg === "--out") {
            const value = argv[index + 1];
            if (value === undefined) throw new Error(`${arg} needs a value.`);
            index += 1;
            if (arg === "--out") {
                options.out = resolve(value);
            } else {
                options.pace = Number(value);
                if (!Number.isFinite(options.pace) || options.pace < 0) throw new Error("--pace needs a number of milliseconds, 0 or more.");
            }
        } else {
            throw new Error(`Unknown flag ${arg}.`);
        }
    }
    return options;
}

// The effort pill only shows for a model with two or more levels, so the scripted model gets them here.
function giveCrowEffortLevels(home) {
    const path = join(home, "runtime", "cache", "faux-0.json");
    const catalog = JSON.parse(readFileSync(path, "utf8"));
    for (const model of catalog.models) {
        if (model.id !== "crow-0") continue;
        model.levels = [{ id: "low", label: "Low" }, { id: "high", label: "High" }];
        model.default_level = "high";
    }
    writeFileSync(path, JSON.stringify(catalog));
}

function log(text) {
    console.log(`[tour ${new Date().toISOString().slice(11, 19)}] ${text}`);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(check, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await check().catch(() => false)) return true;
        await pause(100);
    }
    return false;
}

function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function createTour({ app, page, folder, pace, real, out, shots }) {
    const typingDelay = Math.max(1, Math.round(pace * 0.04));
    const tour = {
        app,
        page,
        folder,
        pace,
        real,
        typingDelay,
        step: undefined,
        beat: (count = 1) => pause(pace * count),
        async shot(label = "") {
            const suffix = label ? `-${label}` : "";
            const file = join(out, `${tour.step.number}-${tour.step.name}${suffix}.png`);
            await page.screenshot({ path: file });
            shots.push(file);
            tour.step.shots += 1;
            log(`shot ${file}`);
        },
        async press(key, modifiers) {
            await app.evaluate(({ BrowserWindow }, { key, modifiers }) => {
                const contents = BrowserWindow.getAllWindows()[0].webContents;
                contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
                contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
            }, { key, modifiers });
        },
        async send(text) {
            const input = page.locator(".composer-input");
            await input.click();
            await input.pressSequentially(text, { delay: typingDelay });
            await tour.beat();
            await input.press("Enter");
        },
        sendMode: () => page.locator(".send-button").getAttribute("data-mode"),
        async waitForTurnEnd(timeout = 60_000) {
            await poll(async () => (await tour.sendMode()) === "stop", 5_000);
            if (!await poll(async () => (await tour.sendMode()) === "send", timeout)) {
                throw new Error("The turn did not end.");
            }
        },
        async closeMenu() {
            await page.keyboard.press("Escape");
            // The popover keeps catching clicks while it fades, so this wait does not shrink with --pace.
            await pause(Math.max(pace * 2, 800));
        },
        async openPage(kind) {
            await page.locator(`[data-page="${kind}"]`).first().click();
            await tour.beat();
        },
    };
    return tour;
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    if (options.real && !process.env.OPENROUTER_API_KEY) {
        console.error("--real needs OPENROUTER_API_KEY in the environment. Nothing was started.");
        return 2;
    }
    if (options.real && !existsSync(FACTORY_CONFIG)) {
        console.error(`--real needs ${FACTORY_CONFIG}. Nothing was started.`);
        return 2;
    }

    const trial = startTrial();
    const trialRoot = dirname(trial.home);
    const out = options.out ?? join(tmpdir(), `vera-desktop-tour-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    let provider;
    let app;
    let cleanupRun;
    const cleanup = () => {
        cleanupRun ??= (async () => {
            await trial.cleanup().catch((error) => console.error(`Cleanup: ${error.message}`));
            await provider?.close();
        })();
        return cleanupRun;
    };
    process.once("SIGINT", () => {
        console.error("\nInterrupted, cleaning up.");
        cleanup().finally(() => process.exit(130));
    });

    const shots = [];
    const failed = [];
    let exitCode = 0;
    try {
        if (out === trialRoot || out.startsWith(trialRoot + sep)) {
            console.error("--out must be outside the trial root, which is deleted at the end.");
            return 2;
        }
        mkdirSync(out, { recursive: true });
        const folder = join(trialRoot, "crow-nest");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "treasure.md"), TREASURE);
        if (options.real) {
            mkdirSync(trial.home, { recursive: true });
            copyFileSync(FACTORY_CONFIG, join(trial.home, "config.json"));
        } else {
            provider = await startTourProvider();
            configureFauxHome(trial.home, provider.port, "auto");
            giveCrowEffortLevels(trial.home);
        }

        app = await trial.launch({ visible: true });
        const page = await app.firstWindow();
        await page.waitForSelector(".app", { timeout: 45_000 });
        await app.evaluate(({ dialog, BrowserWindow }, chosen) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
            const window = BrowserWindow.getAllWindows()[0];
            window.setBounds({ x: 80, y: 60, width: 1440, height: 900 });
            window.show();
            window.focus();
        }, folder);
        await trial.waitForHost();

        const tour = createTour({ app, page, folder, pace: options.pace, real: options.real, out, shots });
        let aborted = false;
        for (const [index, step] of steps.entries()) {
            tour.step = { number: String(index + 1).padStart(2, "0"), name: slug(step.name), shots: 0 };
            log(`step ${tour.step.number} ${step.name}`);
            try {
                await step.run(tour);
                if (tour.step.shots === 0) await tour.shot();
            } catch (error) {
                failed.push(step.name);
                log(`FAILED ${step.name}: ${String(error.message ?? error).split("\n")[0]}`);
                await tour.shot("failed").catch(() => {});
                await page.keyboard.press("Escape").catch(() => {});
                if (step.critical) {
                    aborted = true;
                    log("Tour aborted: later steps would send messages to other places.");
                    break;
                }
            }
        }

        try {
            const sheet = await writeSheet(app, out, shots);
            log(`sheet ${sheet}`);
        } catch (error) {
            failed.push("sheet");
            log(`FAILED sheet: ${error.message}`);
        }
        exitCode = failed.length > 0 ? 1 : 0;

        console.log(`out dir: ${out}`);
        console.log(`screenshots: ${shots.length} PNG files plus sheet.png`);
        console.log(`trial home: ${trial.home}`);
        console.log(`electron pid: ${app.process().pid}`);
        console.log(`host pid: ${trial.hostPid() ?? "none"}`);
        if (failed.length > 0) console.log(`failed: ${failed.join(", ")}`);

        if (options.keepOpen && !aborted) {
            log("Tour done. The window stays open; close it to clean up.");
            await Promise.race([
                page.waitForEvent("close", { timeout: 0 }),
                app.waitForEvent("close", { timeout: 0 }),
            ]);
        }
    } catch (error) {
        console.error(error);
        exitCode = 1;
    } finally {
        await cleanup();
    }
    return exitCode;
}

main().then((code) => process.exit(code));
