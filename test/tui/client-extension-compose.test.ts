import { expect, test } from "bun:test";

import {
    captureTuiExtensionComposeTarget,
    isCurrentTuiExtensionComposeTarget,
} from "../../clients/tui/client-extension-compose.ts";
import type { TuiAgentClient } from "../../clients/tui/agent-client.ts";

function client(): TuiAgentClient {
    return {} as TuiAgentClient;
}

test("a composer target cannot become current after a pane round trip", () => {
    const main = client();
    const sidebar = client();
    const target = captureTuiExtensionComposeTarget({
        client: main,
        clientGeneration: 1,
        surfaceGeneration: 4,
    });

    expect(isCurrentTuiExtensionComposeTarget(target, {
        client: sidebar,
        clientGeneration: 1,
        surfaceGeneration: 5,
        sessionSwitchPending: false,
    })).toBe(false);
    expect(isCurrentTuiExtensionComposeTarget(target, {
        client: main,
        clientGeneration: 1,
        surfaceGeneration: 6,
        sessionSwitchPending: false,
    })).toBe(false);
});

test("a pending session switch permanently stales its composer target", () => {
    const main = client();
    const target = captureTuiExtensionComposeTarget({
        client: main,
        clientGeneration: 1,
        surfaceGeneration: 4,
    });

    expect(isCurrentTuiExtensionComposeTarget(target, {
        client: main,
        clientGeneration: 1,
        surfaceGeneration: 4,
        sessionSwitchPending: true,
    })).toBe(false);
    expect(isCurrentTuiExtensionComposeTarget(target, {
        client: main,
        clientGeneration: 1,
        surfaceGeneration: 4,
        sessionSwitchPending: false,
    })).toBe(false);
});
