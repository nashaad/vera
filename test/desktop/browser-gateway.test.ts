import { expect, test } from "bun:test";

import { BrowserGateway } from "../../clients/desktop/src/browser/gateway.ts";
import type { BrowserCdp } from "../../clients/desktop/src/browser/cdp.ts";
import type { BrowserRequest } from "../../extensions/builtin-browser/arguments.ts";
import type { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";

interface PendingSetting {
    readonly resolve: (value: JsonValue) => void;
    readonly reject: (reason: Error) => void;
}

function trial() {
    const pending: PendingSetting[] = [];
    const changes: { enabled: boolean; available: boolean }[] = [];
    const request: typeof requestExtensionThroughHost = (_socket, _extension, name, _payload, signal) => {
        if (name === "poll") return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        if (name !== "settings") throw new Error(`Unexpected request: ${name}`);
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    };
    const gateway = new BrowserGateway({} as BrowserCdp, () => {}, () => {
        changes.push({ enabled: gateway.enabled, available: gateway.available });
    }, request);
    gateway.start("trial");
    return { gateway, pending, changes };
}

test("@core an eval job reaches the pane with its script and timeout", async () => {
    const replies: JsonValue[] = [];
    let first = true;
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, payload, signal) => {
        if (name === "settings") return { enabled: true, offBehavior: "ask" };
        if (name === "reply") { replies.push(payload); return true; }
        if (first) {
            first = false;
            await Bun.sleep(1);
            return { id: "job", request: { action: "eval", script: "return document.title", timeout_ms: 1500 } };
        }
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const seen: BrowserRequest[] = [];
    const cdp = { run: async (job: BrowserRequest) => { seen.push(job); return { output: "\"Example\"", total: 9 }; } } as unknown as BrowserCdp;
    const gateway = new BrowserGateway(cdp, () => {}, () => {}, request);
    gateway.start("trial");
    try {
        for (let i = 0; i < 100 && replies.length === 0; i++) await Bun.sleep(1);
        expect(seen).toEqual([{ action: "eval", script: "return document.title", timeout_ms: 1500 }]);
        expect(replies).toEqual([{ id: "job", output: "\"Example\"", total: 9 }]);
    } finally { gateway.stop(); }
});

test("@core a disabled queued browser request returns a classified refusal", async () => {
    const replies: JsonValue[] = [];
    let first = true;
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, payload, signal) => {
        if (name === "settings") return { enabled: false, offBehavior: "ask" };
        if (name === "reply") { replies.push(payload); return true; }
        if (first) { first = false; return { id: "job", request: { action: "read" } }; }
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    let revealed = false;
    const gateway = new BrowserGateway({} as BrowserCdp, () => { revealed = true; }, () => {}, request);
    gateway.start("trial");
    try {
        for (let i = 0; i < 100 && replies.length === 0; i++) await Bun.sleep(1);
        expect(replies).toEqual([{ id: "job", error: "Browser tools are off. Open Browser in the right pane, turn on the Browser tools switch, then try again.", errorCode: "browser_tools_off" }]);
        expect(revealed).toBe(false);
    } finally { gateway.stop(); }
});

test("@core gateway forwards structured read results without formatting", async () => {
    const replies: JsonValue[] = [];
    let pollCount = 0;
    const payload = { url: "https://example.org/", title: "Example", html: "<html></html>", htmlTruncated: false, controls: ["r1 link Example"], humanCheck: false };
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, requestPayload, signal) => {
        if (name === "settings") return { enabled: true, offBehavior: "ask" };
        if (name === "reply") { replies.push(requestPayload); return true; }
        pollCount++;
        if (pollCount === 1) return null;
        if (pollCount === 2) return { id: "read-1", request: { action: "read" } };
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const cdp = { run: async () => payload } as unknown as BrowserCdp;
    const gateway = new BrowserGateway(cdp, () => {}, () => {}, request);
    gateway.start("trial");
    try {
        for (let i = 0; i < 100 && replies.length === 0; i++) await Bun.sleep(1);
        expect(replies).toEqual([{ id: "read-1", ...payload }]);
    } finally { gateway.stop(); }
});

test("@core gateway keeps the enabled setting when availability is lost", async () => {
    const { gateway, pending, changes } = trial();
    try {
        const write = gateway.settings({ enabled: true });
        pending[1]?.resolve({ enabled: true, offBehavior: "ask" });
        await write;
        pending[0]?.resolve({ enabled: false, offBehavior: "ask" });
        await Promise.resolve();
        expect(gateway.enabled).toBe(true);
        expect(gateway.available).toBe(true);
        const refresh = gateway.settings();
        pending[2]?.reject(new Error("unavailable"));
        await refresh;
        expect(gateway.enabled).toBe(true);
        expect(gateway.available).toBe(false);
        expect(changes).toEqual([
            { enabled: true, available: true },
            { enabled: true, available: false },
        ]);
    } finally {
        gateway.stop();
    }
});

test("@core gateway displays an enable-tools ask without revealing the Browser", async () => {
    const replies: JsonValue[] = [];
    let polls = 0;
    const changes: unknown[] = [];
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, payload, signal) => {
        if (name === "settings") return { enabled: false, offBehavior: "ask" };
        if (name === "reply") { replies.push(payload); return true; }
        if (++polls === 1) return { id: "ask-1", request: { action: "enable_tools" } };
        if (polls === 2) return { cancel: "ask-1" };
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    let revealed = false;
    const gateway = new BrowserGateway({} as BrowserCdp, () => { revealed = true; }, () => {
        changes.push(gateway.pendingToolsAsk);
    }, request);
    gateway.start("trial");
    try {
        for (let i = 0; i < 100 && !changes.some((value) => JSON.stringify(value) === JSON.stringify({ id: "ask-1" })); i++) await Bun.sleep(1);
        expect(changes).toContainEqual({ id: "ask-1" });
        expect(gateway.pendingToolsAsk).toBeUndefined();
        expect(revealed).toBe(false);
        expect(replies).toEqual([{ id: "ask-1", approved: false }]);
    } finally { gateway.stop(); }
});

test("@core turning Browser tools on from the notice persists before approving", async () => {
    const replies: JsonValue[] = [];
    let polls = 0;
    let releasePoll: (() => void) | undefined;
    const writes: JsonValue[] = [];
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, payload, signal) => {
        if (name === "settings") {
            writes.push(payload);
            return payload !== null && typeof payload === "object" && "enabled" in payload
                ? { enabled: true, offBehavior: "refuse" }
                : { enabled: false, offBehavior: "refuse" };
        }
        if (name === "reply") { replies.push(payload); return true; }
        if (++polls === 1) return { id: "ask-2", request: { action: "enable_tools" } };
        if (polls === 2) return await new Promise((resolve, reject) => {
            releasePoll = () => resolve(null);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const gateway = new BrowserGateway({} as BrowserCdp, () => {}, () => {}, request);
    gateway.start("trial");
    try {
        for (let i = 0; i < 100 && gateway.pendingToolsAsk === undefined; i++) await Bun.sleep(1);
        await gateway.answerToolsAsk("ask-2", true);
        releasePoll?.();
        for (let i = 0; i < 100 && replies.length === 0; i++) await Bun.sleep(1);
        expect(writes).toContainEqual({ enabled: true });
        expect(replies).toEqual([{ id: "ask-2", approved: true }]);
        expect(gateway.enabled).toBe(true);
        expect(gateway.offBehavior).toBe("refuse");
    } finally { gateway.stop(); }
});

test("@core an enable-tools ask remains after a failed save and can be retried", async () => {
    const replies: JsonValue[] = [];
    let polls = 0;
    let saveWorks = false;
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, payload, signal) => {
        if (name === "settings") return { enabled: saveWorks, offBehavior: "ask" };
        if (name === "reply") { replies.push(payload); return true; }
        if (++polls === 1) return { id: "ask-write-fails", request: { action: "enable_tools" } };
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const gateway = new BrowserGateway({} as BrowserCdp, () => {}, () => {}, request);
    gateway.start("trial");
    try {
        for (let i = 0; i < 100 && gateway.pendingToolsAsk === undefined; i++) await Bun.sleep(1);
        await gateway.answerToolsAsk("ask-write-fails", true);
        expect(gateway.pendingToolsAsk).toEqual({ id: "ask-write-fails" });
        expect(replies).toEqual([]);
        expect(gateway.enabled).toBe(false);
        saveWorks = true;
        await gateway.answerToolsAsk("ask-write-fails", true);
        for (let i = 0; i < 100 && replies.length === 0; i++) await Bun.sleep(1);
        expect(replies).toEqual([{ id: "ask-write-fails", approved: true }]);
        expect(gateway.enabled).toBe(true);
    } finally { gateway.stop(); }
});

test("off-behavior writes use the shared settings request and retain the last saved value on failure", async () => {
    const calls: JsonValue[] = [];
    let remote = { enabled: true, offBehavior: "refuse" as "ask" | "refuse" };
    let fail = false;
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, payload, signal) => {
        if (name !== "settings") return await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        calls.push(payload);
        if (fail) throw new Error("unavailable");
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
            const patch = payload as Readonly<Record<string, JsonValue>>;
            if (patch.offBehavior === "ask" || patch.offBehavior === "refuse") remote = { ...remote, offBehavior: patch.offBehavior };
            if (typeof patch.enabled === "boolean") remote = { ...remote, enabled: patch.enabled };
        }
        return remote;
    };
    const gateway = new BrowserGateway({} as BrowserCdp, () => {}, () => {}, request);
    gateway.start("trial");
    try {
        for (let i = 0; i < 100 && !gateway.available; i++) await Bun.sleep(1);
        expect(gateway.enabled).toBe(true);
        expect(gateway.offBehavior).toBe("refuse");
        expect(await gateway.settings({ offBehavior: "ask" })).toBe(true);
        expect(calls.at(-1)).toEqual({ offBehavior: "ask" });
        expect(gateway.enabled).toBe(true);
        expect(gateway.offBehavior).toBe("ask");
        fail = true;
        expect(await gateway.settings({ offBehavior: "refuse" })).toBe(false);
        expect(gateway.offBehavior).toBe("ask");
        expect(gateway.available).toBe(false);
    } finally { gateway.stop(); }
});

test("default-browser writes use the shared settings request and decode the stored value", async () => {
    const calls: JsonValue[] = [];
    let reply: JsonValue = "ask";
    const request: typeof requestExtensionThroughHost = async (_socket, _extension, name, payload, signal) => {
        if (name !== "settings") return await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        calls.push(payload);
        return { enabled: true, offBehavior: "ask", defaultBrowser: reply };
    };
    const gateway = new BrowserGateway({} as BrowserCdp, () => {}, () => {}, request);
    gateway.start("trial");
    try {
        for (let i = 0; i < 100 && !gateway.available; i++) await Bun.sleep(1);
        expect(gateway.defaultBrowser).toBe("ask");
        reply = "pane";
        expect(await gateway.settings({ defaultBrowser: "pane" })).toBe(true);
        expect(calls.at(-1)).toEqual({ defaultBrowser: "pane" });
        expect(gateway.defaultBrowser).toBe("pane");
        reply = "chrome";
        expect(await gateway.settings({ defaultBrowser: "chrome" })).toBe(true);
        expect(gateway.defaultBrowser).toBe("chrome");
        reply = "unknown";
        expect(await gateway.settings({ defaultBrowser: "ask" })).toBe(true);
        expect(gateway.defaultBrowser).toBe("ask");
    } finally { gateway.stop(); }
});

test("@core gateway refreshes external setting changes and stops its timer", async () => {
    const { gateway, pending, changes } = trial();
    try {
        pending[0]?.resolve({ enabled: false, offBehavior: "ask" });
        await Promise.resolve();
        await Bun.sleep(1100);
        expect(pending).toHaveLength(2);
        pending[1]?.resolve({ enabled: true, offBehavior: "ask" });
        await Promise.resolve();
        expect(gateway.enabled).toBe(true);
        expect(changes).toEqual([
            { enabled: false, available: true },
            { enabled: true, available: true },
        ]);
        const stale = gateway.settings({ enabled: false });
        gateway.stop();
        pending[2]?.resolve({ enabled: false, offBehavior: "ask" });
        await stale;
        expect(gateway.enabled).toBe(true);
        expect(gateway.available).toBe(false);
        expect(changes.at(-1)).toEqual({ enabled: true, available: false });
        await Bun.sleep(1100);
        expect(pending).toHaveLength(3);
    } finally {
        gateway.stop();
    }
});
