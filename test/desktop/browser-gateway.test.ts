import { expect, test } from "bun:test";

import { BrowserGateway } from "../../clients/desktop/src/browser/gateway.ts";
import type { BrowserCdp } from "../../clients/desktop/src/browser/cdp.ts";
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
