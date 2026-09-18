/** Repointing the local runtime: which command a switch runs, and what it leaves on the screen. */

import { expect, test } from "bun:test";
import { ensureLocalRuntimeProfile, switchLocalRuntimeProfile } from "../../clients/tui/main/outrider-control.ts";
import type { OutriderDriver } from "../../clients/tui/main/outrider-ops.ts";
import type { OutriderProgress } from "../../src/providers/outrider.ts";
import { createTuiState } from "../../clients/tui/state.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";

const SERVED = JSON.stringify({
    gateway: { kind: "running", endpoint: "http://127.0.0.1:11435" },
    model: { kind: "running", preset: "qwen35-2b", health: true },
});

function driver(ran: string[][], stdout = SERVED): OutriderDriver {
    return {
        binary: () => "/bin/outrider",
        run: (command) => {
            ran.push([...command]);
            return { finished: Promise.resolve({ ok: true, stdout, detail: "" }), stop: () => {} };
        },
    };
}

/** A driver whose serve reports a download before it finishes, the way a profile that is not on disk does. */
function fetchingDriver(lines: readonly OutriderProgress[]): OutriderDriver {
    return {
        binary: () => "/bin/outrider",
        run: (command, onProgress) => {
            if (command.includes("serve") || command.includes("use")) {
                for (const line of lines) onProgress(line);
            }
            return { finished: Promise.resolve({ ok: true, stdout: SERVED, detail: "" }), stop: () => {} };
        },
    };
}

function runtime(gateway?: "up" | "down"): TuiRuntime {
    return {
        shuttingDown: true,
        state: createTuiState(),
        localRuntime: gateway === undefined
            ? undefined
            : { provider: "outrider", label: "Outrider", state: "stopped", gateway },
        localRuntimeCommand: undefined,
        localRuntimeNotice: undefined,
        statusNotice: undefined,
        statusNoticeVersion: 0,
        settingsPicker: undefined,
    } as unknown as TuiRuntime;
}

test("a gateway that is already up is repointed rather than restarted", async () => {
    const ran: string[][] = [];
    const rt = runtime("up");
    switchLocalRuntimeProfile(rt, "qwen35-2b", driver(ran));
    await Bun.sleep(10);
    expect(ran[0]).toEqual(["/bin/outrider", "--json", "use", "qwen35-2b"]);
    expect(rt.localRuntime?.state).toBe("running");
    expect(rt.localRuntime?.profile).toBe("qwen35-2b");
});

test("with nothing up the switch is what brings the gateway up", async () => {
    const ran: string[][] = [];
    switchLocalRuntimeProfile(runtime("down"), "qwen35-2b", driver(ran));
    await Bun.sleep(10);
    expect(ran[0]).toEqual(["/bin/outrider", "--json", "serve", "qwen35-2b"]);
});

test("a switch that fails says so without claiming the profile changed", async () => {
    const ran: string[][] = [];
    const rt = runtime("up");
    const failing: OutriderDriver = {
        binary: () => "/bin/outrider",
        run: (command) => {
            ran.push([...command]);
            return ran.length === 1
                ? { finished: Promise.resolve({ ok: false, stdout: "", detail: "no such profile" }), stop: () => {} }
                : { finished: Promise.resolve({ ok: true, stdout: SERVED, detail: "" }), stop: () => {} };
        },
    };
    switchLocalRuntimeProfile(rt, "nope", failing);
    await Bun.sleep(10);
    expect(rt.localRuntime?.failure).toBe("could not switch to nope: no such profile");
    expect(rt.localRuntimeCommand).toBeUndefined();
});

test("a profile already loaded is not reloaded before a probe", async () => {
    const ran: string[][] = [];
    const rt = runtime("up");
    await ensureLocalRuntimeProfile(rt, "qwen35-2b", driver(ran));
    expect(ran).toEqual([["/bin/outrider", "--json", "status"]]);
    expect(rt.localRuntime?.profile).toBe("qwen35-2b");
});

test("a probe of another profile waits for the runtime to hold it", async () => {
    const ran: string[][] = [];
    const rt = runtime("up");
    const stdout = JSON.stringify({
        gateway: { kind: "running", endpoint: "http://127.0.0.1:11435" },
        model: { kind: "running", preset: "ling3-tiny" },
    });
    await ensureLocalRuntimeProfile(rt, "qwen35-2b", driver(ran, stdout));
    expect(ran.map((command) => command.slice(2).join(" ")))
        .toEqual(["status", "serve qwen35-2b", "status"]);
});

test("a switch that has to fetch says how far the fetch has got", async () => {
    const rt = runtime("up");
    switchLocalRuntimeProfile(rt, "qwen35-2b", fetchingDriver([
        { name: "qwen35-2b", done: false, downloaded: 1_400_000_000, total: 2_800_000_000, etaSeconds: 45 },
    ]));
    await Bun.sleep(10);
    expect(rt.statusNotice).toBe("Outrider · serving qwen35-2b · http://127.0.0.1:11435");
});

test("the fetch is reported while it runs, not only once it lands", () => {
    const rt = runtime("up");
    const said: string[] = [];
    switchLocalRuntimeProfile(rt, "qwen35-2b", {
        binary: () => "/bin/outrider",
        run: (_command, onProgress) => {
            onProgress({ name: "qwen35-2b", done: false, downloaded: 1_400_000_000, total: 2_800_000_000, etaSeconds: 45 });
            said.push(rt.statusNotice ?? "");
            return { finished: new Promise(() => {}), stop: () => {} };
        },
    });
    expect(said).toEqual(["Outrider · switching model… 50% · 1.4 GB / 2.8 GB · ~45 sec"]);
});

test("the provider screen carries the section, so nothing is said twice", () => {
    const rt = runtime("up");
    (rt as { settingsPicker?: unknown }).settingsPicker = { kind: "provider" };
    switchLocalRuntimeProfile(rt, "qwen35-2b", fetchingDriver([]));
    expect(rt.statusNotice).toBeUndefined();
});
