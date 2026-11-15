import { expect, test } from "bun:test";

import { currentToasts, dismissToast } from "../../clients/ui/src/overlays/toasts.ts";
import type { Route } from "../../clients/ui/src/pages/routes.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import { takePendingAgent } from "../../clients/ui/src/session/pendingAgent.ts";
import { HELP_AGENT, startHelpChat } from "../../clients/ui/src/session/startHelp.ts";

function bridgeWith(createSession: unknown): DesktopBridge {
    return { createSession } as unknown as DesktopBridge;
}

test("@core a Help press opens a new chat on the Help agent", async () => {
    let created = 0;
    const bridge = bridgeWith(async () => {
        created += 1;
        return { ok: true, agentId: `crow-${created}`, workspace: "/nest" };
    });
    const routes: Route[] = [];
    await startHelpChat(bridge, (route) => routes.push(route));
    await startHelpChat(bridge, (route) => routes.push(route));

    expect(routes.map((route) => (route.kind === "session" ? route.agentId : route.kind))).toEqual(["crow-1", "crow-2"]);
    expect(takePendingAgent("crow-1")).toBe(HELP_AGENT);
    expect(takePendingAgent("crow-1")).toBeUndefined();
    expect(takePendingAgent("crow-2")).toBe(HELP_AGENT);
});

test("@core a Help press that cannot create a chat opens nothing and says so", async () => {
    const routes: Route[] = [];
    await startHelpChat(bridgeWith(async () => ({ ok: false, reason: "The host is busy." })), (route) => routes.push(route));
    await startHelpChat(bridgeWith(async () => { throw new Error("socket closed"); }), (route) => routes.push(route));

    expect(routes).toEqual([]);
    const texts = currentToasts().map((toast) => toast.text);
    expect(texts).toContain("The host is busy.");
    expect(texts).toContain("Vera could not start a Help chat.");
    for (const toast of currentToasts()) dismissToast(toast.id);
});
