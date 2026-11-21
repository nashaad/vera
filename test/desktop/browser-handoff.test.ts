import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { BrowserGateway } from "../../clients/desktop/src/browser/gateway.ts";
import { BrowserHandoff } from "../../clients/desktop/src/browser/handoff.ts";
import { NO_WEB_PAGE_ERROR, type BrowserCdp } from "../../clients/desktop/src/browser/cdp.ts";
import type { BrowserPane } from "../../clients/desktop/src/browser/pane.ts";
import { HANDOFF_BUSY, HANDOFF_CANCELLED, HANDOFF_DONE, HANDOFF_SKIPPED } from "../../extensions/builtin-browser/handoff.ts";
import type { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";

function pageTrial() {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    let active: number | null = 7;
    const pane = { current: () => active === null ? undefined : contents, state: () => ({ active }) } as unknown as BrowserPane;
    let changes = 0;
    const handoff = new BrowserHandoff(pane, () => { changes++; });
    return { contents, handoff, changes: () => changes, closePage: () => { active = null; } };
}

async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (check()) return;
        await Bun.sleep(1);
    }
    throw new Error("Condition not reached");
}

test("@core handoff binds to a page and accepts only its current answer", async () => {
    const trial = pageTrial();
    const done = trial.handoff.start("first", "Complete the check");
    expect(trial.handoff.state()).toEqual({ id: "first", page: 7, reason: "Complete the check" });
    trial.handoff.complete("stale", "done");
    expect(trial.handoff.state()?.id).toBe("first");
    trial.handoff.complete("first", "done");
    expect(await done).toEqual({ output: HANDOFF_DONE });
    expect(trial.handoff.state()).toBeUndefined();
    const skipped = trial.handoff.start("second", "Complete the check");
    trial.handoff.complete("second", "skipped");
    expect(await skipped).toEqual({ output: HANDOFF_SKIPPED });
    expect(trial.changes()).toBe(4);
    expect(trial.contents.listenerCount("destroyed")).toBe(0);
});

test("@core handoff closes when its page is destroyed and rejects a missing page", async () => {
    const trial = pageTrial();
    const pending = trial.handoff.start("first", "Complete the check");
    trial.contents.emit("destroyed");
    expect(await pending).toEqual({ output: HANDOFF_CANCELLED });
    expect(trial.handoff.state()).toBeUndefined();
    trial.closePage();
    expect(() => trial.handoff.start("second", "Complete the check")).toThrow(NO_WEB_PAGE_ERROR);
});

test("@core gateway polls during handoff and refuses other browser jobs", async () => {
    const trial = pageTrial();
    const replies: JsonValue[] = [];
    const queued: JsonValue[] = [];
    let waiting: ((job: JsonValue) => void) | undefined;
    const deliver = (job: JsonValue): void => {
        if (waiting === undefined) queued.push(job);
        else { const resolve = waiting; waiting = undefined; resolve(job); }
    };
    let runs = 0;
    let reveals = 0;
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, payload, signal) => {
        if (name === "settings") return { enabled: true };
        if (name === "reply") { replies.push(payload); return true; }
        const next = queued.shift();
        if (next !== undefined) return next;
        return await new Promise((resolve, reject) => {
            const abort = (): void => { waiting = undefined; reject(signal.reason); };
            waiting = (job) => { signal.removeEventListener("abort", abort); resolve(job); };
            signal.addEventListener("abort", abort, { once: true });
        });
    };
    const cdp = { run: async () => { runs++; return { output: "page" }; } } as unknown as BrowserCdp;
    const gateway = new BrowserGateway(cdp, () => { reveals++; }, () => {}, request, trial.handoff);
    gateway.start("trial");
    try {
        await gateway.settings(true);
        deliver({ id: "first", request: { action: "handoff", reason: "Complete the check" } });
        await until(() => trial.handoff.state()?.id === "first");
        deliver({ id: "other", request: { action: "read" } });
        await until(() => replies.length === 1);
        expect(replies[0]).toEqual({ id: "other", error: HANDOFF_BUSY });
        expect(runs).toBe(0);
        expect(reveals).toBe(1);
        trial.handoff.complete("first", "done");
        await until(() => replies.length === 2);
        expect(replies[1]).toEqual({ id: "first", output: HANDOFF_DONE });
        deliver({ id: "after", request: { action: "read" } });
        await until(() => replies.length === 3);
        expect(replies[2]).toEqual({ id: "after", output: "page" });
        expect(runs).toBe(1);

        deliver({ id: "cancelled", request: { action: "handoff", reason: "Complete the check" } });
        await until(() => trial.handoff.state()?.id === "cancelled");
        deliver({ cancel: "cancelled" });
        await until(() => trial.handoff.state() === undefined);
        await until(() => replies.length === 4);
        expect(replies[3]).toEqual({ id: "cancelled", output: HANDOFF_CANCELLED });
    } finally { gateway.stop(); }
});
