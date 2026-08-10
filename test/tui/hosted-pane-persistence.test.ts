import { expect, test } from "bun:test";

import type { TuiPersistedAgentPane } from
    "../../clients/tui/theme-preference.ts";
import { TuiHostedPanePersistence } from
    "../../clients/tui/hosted-pane-persistence.ts";

function recorder(groups: readonly (readonly [string, string])[] = []) {
    const savedGroups: Array<readonly (readonly [string, string])[]> = [];
    const savedPanes: Array<readonly [string, TuiPersistedAgentPane | undefined]> = [];
    const persistence = new TuiHostedPanePersistence({
        groups,
        saveGroups(value) {
            savedGroups.push(value);
        },
        savePane(mainId, pane) {
            savedPanes.push([mainId, pane]);
        },
    });
    return { persistence, savedGroups, savedPanes };
}

function restorableClient() {
    const detached: string[] = [];
    const closed: string[] = [];
    return {
        detached,
        closed,
        client: {
            async detach() {
                detached.push("detached");
            },
            close() {
                closed.push("closed");
            },
        },
    };
}

test("a durable sidebar replaces overlapping groups and persists its identity", () => {
    const { persistence, savedGroups, savedPanes } = recorder([
        ["main", "old-side"],
        ["other", "keep"],
    ]);

    persistence.remember({
        mainAgentId: "main",
        sidebarAgentId: "new-side",
        owner: "vera.btw",
        mention: "peer",
        statusLabel: "pair",
        attachmentLifetime: "durable",
    });

    expect(persistence.groups).toEqual([
        ["other", "keep"],
        ["main", "new-side"],
    ]);
    expect(savedGroups.at(-1)).toEqual(persistence.groups);
    expect(savedPanes.at(-1)).toEqual(["main", {
        mainAgentId: "main",
        sidebarAgentId: "new-side",
        owner: "vera.btw",
        mention: "peer",
        statusLabel: "pair",
    }]);
});

test("an ephemeral sidebar removes stale durable relationships", () => {
    const { persistence, savedPanes } = recorder([
        ["main", "old-side"],
        ["ephemeral", "other"],
        ["keep", "together"],
    ]);

    persistence.remember({
        mainAgentId: "main",
        sidebarAgentId: "ephemeral",
        attachmentLifetime: "ephemeral",
    });

    expect(persistence.groups).toEqual([["keep", "together"]]);
    expect(savedPanes.at(-1)).toEqual(["main", undefined]);
});

test("preference failures do not prevent in-memory pane grouping", () => {
    const persistence = new TuiHostedPanePersistence({
        groups: [],
        saveGroups() {
            throw new Error("disk full");
        },
        savePane() {
            throw new Error("disk full");
        },
    });

    expect(() => persistence.remember({
        mainAgentId: "main",
        sidebarAgentId: "side",
        attachmentLifetime: "durable",
    })).not.toThrow();
    expect(persistence.groups).toEqual([["main", "side"]]);
    expect(() => persistence.forget("main")).not.toThrow();
});

test("restore attaches and adopts the saved sidebar for the current main agent", async () => {
    const attached: string[] = [];
    const adopted: string[] = [];
    const side = restorableClient();
    const persistence = new TuiHostedPanePersistence({
        groups: [],
        loadPane: () => ({
            mainAgentId: "main",
            sidebarAgentId: "side",
            owner: "vera.btw",
        }),
        saveGroups() {},
        savePane() {},
    });

    expect(await persistence.restore("main", {
        async attach(agentId) {
            attached.push(agentId);
            return side.client;
        },
        isCurrent: () => true,
        async adopt(saved) {
            adopted.push(saved.owner);
        },
    })).toBe(true);
    expect(attached).toEqual(["side"]);
    expect(adopted).toEqual(["vera.btw"]);
});

test("restore detaches a sidebar when the main agent changes during attach", async () => {
    const side = restorableClient();
    const persistence = new TuiHostedPanePersistence({
        groups: [],
        loadPane: () => ({
            mainAgentId: "main",
            sidebarAgentId: "side",
            owner: "vera.btw",
        }),
        saveGroups() {},
        savePane() {},
    });

    expect(await persistence.restore("main", {
        attach: async () => side.client,
        isCurrent: () => false,
        adopt: async () => {
            throw new Error("must not adopt");
        },
    })).toBe(false);
    expect(side.detached).toEqual(["detached"]);
    expect(side.closed).toEqual([]);
});

test("a failed restore forgets the stale pane", async () => {
    const forgotten: string[] = [];
    const persistence = new TuiHostedPanePersistence({
        groups: [],
        loadPane: () => ({
            mainAgentId: "main",
            sidebarAgentId: "missing",
            owner: "vera.btw",
        }),
        saveGroups() {},
        savePane(mainId, pane) {
            if (pane === undefined) forgotten.push(mainId);
        },
    });

    await expect(persistence.restore("main", {
        attach: async () => {
            throw new Error("not found");
        },
        isCurrent: () => true,
        adopt: async () => {},
    })).rejects.toThrow("not found");
    expect(forgotten).toEqual(["main"]);
});
