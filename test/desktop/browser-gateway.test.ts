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
        if (name === "settings") return { enabled: true };
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
        if (name === "settings") return { enabled: false };
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
        if (name === "settings") return { enabled: true };
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
        const write = gateway.settings(true);
        pending[1]?.resolve({ enabled: true });
        await write;
        pending[0]?.resolve({ enabled: false });
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

test("@core gateway refreshes external setting changes and stops its timer", async () => {
    const { gateway, pending, changes } = trial();
    try {
        pending[0]?.resolve({ enabled: false });
        await Promise.resolve();
        await Bun.sleep(1100);
        expect(pending).toHaveLength(2);
        pending[1]?.resolve({ enabled: true });
        await Promise.resolve();
        expect(gateway.enabled).toBe(true);
        expect(changes).toEqual([
            { enabled: false, available: true },
            { enabled: true, available: true },
        ]);
        const stale = gateway.settings(false);
        gateway.stop();
        pending[2]?.resolve({ enabled: false });
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
