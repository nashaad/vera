import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    UPDATE_CHECK_INTERVAL_MS,
    checkForUpdate,
    readUpdateMode,
    runUpdate,
    shouldCheckNow,
    writeUpdateMode,
    type UpdateProgress,
} from "../../clients/shared/updates.ts";
import { loadVeraConfig, startingVeraConfig } from "../../src/config.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-updates-"));
    roots.push(root);
    return root;
}

// A stand-in for the vera command: the body runs under sh.
function fakeVera(body: string): string {
    const path = join(scratch(), "vera");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
}

test("@core a check happens on the first run, after six hours, and after the clock moved back", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(shouldCheckNow(undefined, 1_000)).toBe(true);
    expect(shouldCheckNow(1_000, 1_000 + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldCheckNow(1_000, 1_000 + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
    expect(shouldCheckNow(5_000, 1_000)).toBe(true);
});

test("@core the update mode defaults to ask and ignores a value it does not know", () => {
    const home = scratch();
    expect(readUpdateMode(home)).toBe("ask");
    writeFileSync(join(home, "config.json"), "{not json");
    expect(readUpdateMode(home)).toBe("ask");
    writeFileSync(join(home, "config.json"), JSON.stringify({ updates: { mode: "sometimes" } }));
    expect(readUpdateMode(home)).toBe("ask");
    writeFileSync(join(home, "config.json"), JSON.stringify({ updates: { mode: "off" } }));
    expect(readUpdateMode(home)).toBe("off");
});

test("@core saving the update mode keeps every other key and every other updates key", () => {
    const home = scratch();
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.5",
        hooks: { a: "b" },
        updates: { mode: "ask", note: "kept" },
    }));
    writeUpdateMode(home, "automatic");
    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.5",
        hooks: { a: "b" },
        updates: { mode: "automatic", note: "kept" },
    });
    expect(readUpdateMode(home)).toBe("automatic");
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("a home with no config starts from the starting file and still loads as a config", () => {
    const home = scratch();
    writeUpdateMode(home, "off");
    const path = join(home, "config.json");
    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(saved.updates).toEqual({ mode: "off" });
    const { updates: _updates, ...starting } = saved;
    const { approval_mode: _unwritten, ...engineStarting } = startingVeraConfig();
    expect(starting).toEqual(engineStarting);
    expect(loadVeraConfig({ path }).model).toBe(engineStarting.model);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readUpdateMode(home)).toBe("off");
});

test("a config that cannot be read is left alone and the save says why", () => {
    const home = scratch();
    const path = join(home, "config.json");
    writeFileSync(path, "{broken");
    expect(() => writeUpdateMode(home, "off")).toThrow("could not be read, so the update setting was not saved");
    expect(readFileSync(path, "utf8")).toBe("{broken");
    writeFileSync(path, "[]");
    expect(() => writeUpdateMode(home, "off")).toThrow("is not a JSON object");
    expect(readFileSync(path, "utf8")).toBe("[]");
});

test("@core a check reads the one JSON object the command prints, even when the command exits non-zero", async () => {
    const available = fakeVera(`printf '%s\\n' '{"status":"available","current_version":"0.1.0","current_build":"vera-aaa","latest_version":"0.2.0","message":"Vera 0.2.0 is out."}'`);
    expect(await checkForUpdate({ veraCommand: available })).toEqual({
        status: "available",
        currentVersion: "0.1.0",
        currentBuild: "vera-aaa",
        latestVersion: "0.2.0",
        message: "Vera 0.2.0 is out.",
    });
    const unavailable = fakeVera(`printf '%s\\n' '{"status":"unavailable","current_version":"0.1.0","current_build":"vera-aaa","message":"offline"}'; exit 3`);
    expect(await checkForUpdate({ veraCommand: unavailable })).toEqual({
        status: "unavailable",
        currentVersion: "0.1.0",
        currentBuild: "vera-aaa",
        message: "offline",
    });
});

test("@core a check that cannot run or prints nothing usable answers unavailable and never throws", async () => {
    const missing = await checkForUpdate({ veraCommand: join(scratch(), "no-such-vera") });
    expect(missing.status).toBe("unavailable");
    expect(missing.message).toContain("Could not run");
    const noise = await checkForUpdate({ veraCommand: fakeVera(`echo "something broke" >&2; exit 1`) });
    expect(noise).toEqual({ status: "unavailable", currentVersion: "", currentBuild: "", message: "something broke" });
    const odd = await checkForUpdate({ veraCommand: fakeVera(`echo '{"status":"fine"}'`) });
    expect(odd.status).toBe("unavailable");
});

test("@core a check passes its environment to the command", async () => {
    const command = fakeVera(`printf '{"status":"up_to_date","current_version":"%s","current_build":"b"}\\n' "$VERA_TEST_VERSION"`);
    const check = await checkForUpdate({ veraCommand: command, env: { VERA_TEST_VERSION: "9.9.9" } });
    expect(check.currentVersion).toBe("9.9.9");
});

test("@core a run reports each progress line in order and ends with the result line", async () => {
    const command = fakeVera(`
echo '{"phase":"checking"}'
echo '{"phase":"downloading","bytes":10,"total":100}'
echo '{"phase":"downloading","bytes":100}'
echo 'not json'
echo '{"phase":"waiting","sessions":[{"id":"s1","title":"Fix build"},{"id":"s2"}],"waited_ms":5,"limit_ms":60000}'
echo '{"phase":"unknown"}'
echo '{"phase":"switching"}'
echo '{"result":"done","version":"0.2.0","build":"vera-bbb","changed":true}'
echo "$@" >&2
`);
    const seen: UpdateProgress[] = [];
    const run = runUpdate({ veraCommand: command }, (progress) => seen.push(progress));
    expect(await run.done).toEqual({ result: "done", version: "0.2.0", build: "vera-bbb", changed: true });
    expect(seen).toEqual([
        { phase: "checking" },
        { phase: "downloading", bytes: 10, total: 100 },
        { phase: "downloading", bytes: 100 },
        { phase: "waiting", sessions: [{ id: "s1", title: "Fix build" }, { id: "s2", title: "s2" }], waitedMs: 5, limitMs: 60_000 },
        { phase: "switching" },
    ]);
    expect(run.cancel()).toBe(false);
});

test("a run asks for download only with the flag and plain json otherwise", async () => {
    const command = fakeVera(`printf '{"result":"downloaded","message":"%s","changed":false}\\n' "$*"`);
    expect((await runUpdate({ veraCommand: command }, () => undefined).done).message).toBe("update --json");
    expect((await runUpdate({ veraCommand: command, downloadOnly: true }, () => undefined).done).message)
        .toBe("update --json --download-only");
});

test("@core a run whose command dies before a result ends failed with nothing changed", async () => {
    const dies = fakeVera(`echo '{"phase":"checking"}'; echo "disk is full" >&2; exit 1`);
    expect(await runUpdate({ veraCommand: dies }, () => undefined).done).toEqual({
        result: "failed",
        message: "disk is full",
        changed: false,
    });
    const missing = await runUpdate({ veraCommand: join(scratch(), "no-such-vera") }, () => undefined).done;
    expect(missing.result).toBe("failed");
    expect(missing.changed).toBe(false);
});

test("@core a run that dies after switching says the update must be run again", async () => {
    const command = fakeVera(`echo '{"phase":"switching"}'; exit 9`);
    const outcome = await runUpdate({ veraCommand: command }, () => undefined).done;
    expect(outcome.result).toBe("failed");
    expect(outcome.message).toContain("Run the update again");
});

test("@core cancel ends a run before switching and refuses once the switch has started", async () => {
    const waiting = fakeVera(`
sleep 30 &
napper=$!
trap 'kill $napper; echo "{\\"result\\":\\"cancelled\\",\\"changed\\":false}"; exit 0' TERM
echo '{"phase":"checking"}'
wait $napper
`);
    const seen: UpdateProgress[] = [];
    const run = runUpdate({ veraCommand: waiting }, (progress) => seen.push(progress));
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run.cancel()).toBe(true);
    expect(await run.done).toEqual({ result: "cancelled", changed: false });

    // The release wrapper keeps INT and TERM for itself and waits for its child, which is the program that cancels.
    const wrapped = fakeVera(`
trap ':' INT
trap 'stopped=1' TERM HUP
(
    trap 'echo "{\\"result\\":\\"cancelled\\",\\"changed\\":false}"; exit 1' TERM
    echo '{"phase":"checking"}'
    sleep 30 &
    wait $!
) &
child=$!
wait $child
code=$?
while [ "$code" -gt 128 ]; do wait $child; code=$?; done
exit $code
`);
    const wrappedSeen: UpdateProgress[] = [];
    const behind = runUpdate({ veraCommand: wrapped }, (progress) => wrappedSeen.push(progress));
    while (wrappedSeen.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(behind.cancel()).toBe(true);
    expect(await behind.done).toEqual({ result: "cancelled", changed: false });

    const marker = join(scratch(), "got-term");
    const switching = fakeVera(`
trap 'echo got > ${marker}' TERM
echo '{"phase":"switching"}'
sleep 1 &
wait $!
sleep 1 &
wait $!
echo '{"result":"done","changed":true}'
`);
    const sawSwitching: UpdateProgress[] = [];
    const second = runUpdate({ veraCommand: switching }, (progress) => sawSwitching.push(progress));
    while (sawSwitching.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.cancel()).toBe(false);
    expect(await second.done).toEqual({ result: "done", changed: true });
    expect(existsSync(marker)).toBe(false);
});
