// Update controls test for the desktop. Run with: node clients/desktop/test/update.e2e.mjs
// A fake `vera` command prints the update contract's JSON; the window's chip, sheet and Settings > Updates drive it.
// Task processes by service name are counted from the start of main: one per request, none left running.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { until } from "./faux-home.mjs";
import { COUNT_PROCESSES, startTrial } from "./trial.mjs";

const SERVICE = "Vera Update";
const HELD = "Vera.app is in a folder Vera cannot write.";

const FAKE = `#!/bin/sh
dir=$(dirname "$0")
printf '%s\\n' "$*" >> "$dir/calls.log"
case " $* " in
    *" --check "*) cat "$dir/check.json"; exit 0 ;;
esac
steps="$dir/steps"
case " $* " in
    *" --download-only "*) steps="$dir/steps-download" ;;
esac
switching=0
on_term() {
    if [ "$switching" = 0 ]; then
        printf '%s\\n' '{"result":"cancelled","changed":false}'
        exit 0
    fi
}
trap on_term TERM INT
while IFS= read -r line; do
    case "$line" in
        "gate "*)
            while [ ! -e "$dir/gate-\${line#gate }" ]; do sleep 0.1 & wait $!; done ;;
        *)
            printf '%s\\n' "$line"
            case "$line" in *'"switching"'*) switching=1 ;; esac ;;
    esac
done < "$steps"
`;

const trial = startTrial();
const fake = join(trial.trialRoot, "fake");
let failed = false;
let app;
let page;

const check = (status, extra = {}) => JSON.stringify({ status, current_version: "1.0.0", current_build: "abc1234", latest_version: "1.1.0", ...extra });
const lines = (...entries) => `${entries.join("\n")}\n`;
const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf8").trim().split("\n") : []);
const open = (name) => writeFileSync(join(fake, `gate-${name}`), "");
const setCheck = (json) => writeFileSync(join(fake, "check.json"), json);
const setSteps = (text) => writeFileSync(join(fake, "steps"), text);

const chip = () => page.locator('.sidebar-foot [data-item="update"]');
const sheet = () => page.locator('[data-overlay="update"]');
const sheetText = async () => (await sheet().innerText()).replace(/\s+/g, " ");
const processes = () => app.evaluate(({ app: electron }, service) => ({
    started: globalThis.utilityStarts[service] ?? 0,
    running: electron.getAppMetrics().filter((metric) => metric.name === service).length,
}), SERVICE);

async function settled() {
    let counted;
    await until("the task processes to stop", async () => {
        counted = await processes();
        return counted.running === 0;
    });
    return counted.started;
}

async function expectSheet(label, ...fragments) {
    await until(label, async () => {
        if (!(await sheet().isVisible())) return false;
        const text = await sheetText();
        return fragments.every((fragment) => text.includes(fragment));
    }, 15_000).catch(async (error) => {
        throw new Error(`${error.message} The sheet reads: ${(await sheet().isVisible()) ? await sheetText() : "(closed)"}`);
    });
}

async function openSettingsUpdates() {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('main[data-page="settings"]').waitFor({ timeout: 10_000 });
    await page.locator(".rail-row", { hasText: "Updates" }).click();
    await page.getByRole("heading", { name: "Updates", exact: true }).waitFor({ timeout: 10_000 });
}

const checkNow = () => page.locator('[data-action="check"]');
const statusLine = async () => (await page.locator(".setting", { has: page.locator('[data-action="check"]') }).locator(".setting-desc").innerText()).replace(/\s+/g, " ");
const mode = (label) => page.getByRole("group", { name: "New versions" }).getByRole("button", { name: label, exact: true });

try {
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "vera"), FAKE);
    chmodSync(join(fake, "vera"), 0o755);
    setCheck(check("available"));
    setSteps("");
    writeFileSync(join(fake, "steps-download"), lines('{"phase":"downloading","bytes":2097152,"total":4194304}', '{"result":"downloaded","version":"1.1.0","changed":false}'));

    // Real HOME with a mock keychain: a temporary HOME would show the login keychain dialog.
    app = await trial.launch({ args: [...COUNT_PROCESSES, "--use-mock-keychain"], env: { VERA_DESKTOP_UPDATE_COMMAND: join(fake, "vera") } });
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });

    // The check on start finds the update; one task process ran for it and none is left.
    await chip().waitFor({ timeout: 30_000 });
    if ((await chip().innerText()).trim() !== "Update available") throw new Error(`The chip reads "${await chip().innerText()}".`);
    if (await chip().getAttribute("title") !== "Vera 1.1.0 is available") throw new Error("The chip does not name the version.");
    if (await settled() !== 1) throw new Error("The check on start did not use exactly one task process.");
    if (calls().join("|") !== "update --check --json") throw new Error(`The start ran ${calls().join("|")}.`);

    // The chip opens the sheet with the versions, the note and the two choices; Later closes it and the chip stays.
    await chip().click();
    await expectSheet("the offer", "Update Vera", "You have Vera 1.0.0.", "Vera 1.1.0 is available.", "Running work finishes first. Then the window restarts on the new version with this conversation.");
    await sheet().locator('[data-action="update"]').waitFor();
    await sheet().locator('[data-action="later"]').click();
    await sheet().waitFor({ state: "hidden" });
    await chip().waitFor();
    if (calls().length !== 1) throw new Error("Closing the sheet ran a command.");

    // A download that fails changes nothing, keeps the offer, and offers another try.
    setSteps(lines('{"phase":"checking"}', '{"phase":"downloading","bytes":1048576,"total":4194304}', "gate download", '{"result":"failed","message":"The download stopped at 1.0 MB.","changed":false}'));
    await chip().click();
    await sheet().locator('[data-action="update"]').click();
    await expectSheet("the download", "Downloading Vera 1.1.0", "1.0 MB of 4.0 MB");
    if (await sheet().locator("progress").getAttribute("value") !== "0.25") throw new Error("The download bar is not at a quarter.");
    open("download");
    await expectSheet("the failure", "The update did not finish. Nothing was changed.", "The download stopped at 1.0 MB.", "Try again");
    await sheet().locator('[data-action="close"]').click();
    await sheet().waitFor({ state: "hidden" });
    if ((await chip().innerText()).trim() !== "Update available") throw new Error("A failed update took the chip away.");
    if (await settled() !== 2) throw new Error("The failed update did not use exactly one more task process.");

    // Waiting names the sessions and can be cancelled; a cancel changes nothing and offers the update again.
    setSteps(lines(
        '{"phase":"waiting","sessions":[{"id":"crow-1","title":"Fix the build"},{"id":"crow-2","title":"Write the tests"}],"waited_ms":2000,"limit_ms":600000}',
        "gate wait",
        '{"phase":"switching"}',
        "gate switch",
        '{"result":"done","version":"1.1.0","build":"def5678","changed":true}',
    ));
    await chip().click();
    await sheet().locator('[data-action="update"]').click();
    await expectSheet("the wait", "Waiting for running work to finish", "Fix the build", "Write the tests", "Waited 2 s of 10 min.");
    await sheet().locator('[data-action="cancel"]').click();
    await expectSheet("the cancel", "Update cancelled. Nothing was changed.");
    if (calls().filter((line) => line === "update --json").length !== 2) throw new Error(`The update command ran ${calls().join("|")}.`);

    // The retry waits again; once switching starts there is nothing to cancel, and the update ends done.
    await sheet().locator('[data-action="update"]').click();
    await expectSheet("the second wait", "Waiting for running work to finish");
    open("wait");
    await expectSheet("the switch", "Switching to the new version", "Vera restarts when it finishes.");
    if (await sheet().locator('[data-action="cancel"]').count() !== 0) throw new Error("Cancel is offered while switching.");
    open("switch");
    await expectSheet("the result", "Updated to Vera 1.1.0.");
    await sheet().locator('[data-action="close"]').click();
    await sheet().waitFor({ state: "hidden" });
    await chip().waitFor({ state: "hidden" });
    if (await settled() !== 4) throw new Error("The cancelled run and the finished run did not use exactly two more task processes.");

    // Settings > Updates: Check now finds an update again, then a held one takes the chip away and says why.
    await openSettingsUpdates();
    if (!(await statusLine()).includes("Vera 1.0.0 is up to date.")) throw new Error(`The status reads "${await statusLine()}".`);
    await checkNow().click();
    await chip().waitFor({ timeout: 15_000 });
    if (!(await statusLine()).includes("Vera 1.1.0 is available.")) throw new Error(`The status reads "${await statusLine()}".`);
    setCheck(check("held", { message: HELD }));
    await checkNow().click();
    await chip().waitFor({ state: "hidden", timeout: 15_000 });
    await until("the held reason", async () => (await statusLine()).includes(HELD));

    // Off is written to the home's config.json, shows nothing and checks nothing.
    const configPath = join(trial.home, "config.json");
    await mode("Off").click();
    await until("the mode in config.json", async () => existsSync(configPath) && JSON.parse(readFileSync(configPath, "utf8")).updates?.mode === "off");
    await until("Check now to be off", async () => await checkNow().isDisabled());
    const afterOff = await settled();
    const commandsBefore = calls().length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (calls().length !== commandsBefore) throw new Error("A command ran while updates were off.");
    if ((await processes()).started !== afterOff) throw new Error("A task process started while updates were off.");

    // Automatic downloads in the background, and the chip then offers the switch.
    setCheck(check("available"));
    await mode("Automatic").click();
    await until("the background download", async () => calls().includes("update --json --download-only"));
    await chip().waitFor({ timeout: 15_000 });
    await until("the chip to read ready", async () => (await chip().innerText()).trim() === "Update ready");
    if (await chip().getAttribute("title") !== "Vera 1.1.0 is downloaded and ready") throw new Error("The ready chip does not name the version.");
    if (JSON.parse(readFileSync(configPath, "utf8")).updates?.mode !== "automatic") throw new Error("Automatic was not written.");
    await settled();
    console.log("update e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Calls:", calls());
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
}
process.exit(failed ? 1 : 0);
