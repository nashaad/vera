import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { defaultVeraConfigPath, loadVeraConfig } from "../../../src/config.ts";
import { recordModelVerification } from "../../../src/model/pool-file-store.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession, type TuiTestSession } from "../../support/tui-harness.ts";

const models = [
    {
        provider: "openrouter", model: "cove/reason", label: "Reasoner", description: "",
        levels: [
            { id: "low", label: "Low", description: "Less reasoning" },
            { id: "high", label: "High", description: "More reasoning" },
        ],
        defaultLevel: "high",
    },
    { provider: "openrouter", model: "cove/plain", label: "Plain", description: "", levels: [] },
] as const;

async function startClassifierSession(attached = false, verifyGate?: Promise<void>): Promise<{
    readonly session: TuiTestSession;
    readonly configPath: string;
    readonly operations: readonly string[];
    readonly restorePool: () => void;
}> {
    let configPath = "";
    const operations: string[] = [];
    const previousPool = process.env.VERA_POOL_FILE;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-classifier-picker-")),
        width: 120,
        height: 40,
        dependencies: () => {
            configPath = defaultVeraConfigPath();
            process.env.VERA_POOL_FILE = join(configPath, "..", "pool.json");
            writeFileSync(configPath, JSON.stringify({
                schema_version: 1,
                provider: "openrouter",
                model: "cove/plain",
                approval_mode: "ask",
                ...(verifyGate === undefined ? {} : { verify_model_assignments: true }),
                model_assignments: { reviewer: { models: [
                    { name: "prior", provider: "openrouter", model: "cove/prior", reasoning_effort: "low" },
                    { name: "backup", provider: "openrouter", model: "cove/backup", reasoning_effort: "high" },
                ] } },
            }));
            const settings = {
                provider: "openrouter",
                model: "cove/plain",
                availableModels: models,
                pooled: [],
                reviewerDefault: {
                    mode: "fixed" as const,
                    primary: { provider: "openrouter", model: "cove/prior" },
                    fallback: { provider: "openrouter", model: "cove/backup" },
                },
            };
            return {
                client: attached
                    ? createSettingsAnsweringClient({ agentId: "classifier-session", model: "cove/plain", modelSettings: settings })
                    : createHomeClient("/work/vera", { readModelSettings: async () => settings }),
                homeHasSessions: false,
                operateModels: async (operation, onResult) => {
                    operations.push(operation.operation);
                    if (operation.operation === "verify" && verifyGate !== undefined) {
                        await verifyGate;
                        const target = operation.models[0]!;
                        recordModelVerification(`${target.provider}/${target.model}`, { probe: { ok: true, seen: "2026-11-19" } });
                        onResult({ ...target, status: "passed" });
                    }
                    return undefined;
                },
            };
        },
    });
    return {
        session,
        configPath,
        operations,
        restorePool: () => {
            if (previousPool === undefined) delete process.env.VERA_POOL_FILE;
            else process.env.VERA_POOL_FILE = previousPool;
        },
    };
}

function declared(configPath: string) {
    return loadVeraConfig({ path: configPath }).model_assignments?.reviewer?.models ?? [];
}

async function openSettingsClassifier(session: TuiTestSession, slot: "primary" | "fallback" = "primary"): Promise<void> {
    await session.waitForVisiblePaneWhere(
        (pane) => pane.includes("V  E  R  A") || pane.includes("Start a conversation with Vera"),
        "Home or conversation",
    );
    session.sendKey("C-p");
    await session.waitForVisiblePane("Commands");
    session.sendText("open settings");
    session.sendKey("Enter");
    await session.waitForVisiblePane("Classifier");
    session.sendText("classifier");
    session.sendKey("Enter");
    await session.waitForVisiblePane("Primary");
    if (slot === "fallback") session.sendKey("Down");
    session.sendKey("Enter");
    await session.waitForVisiblePane("Reasoner");
}

async function openDefaultsClassifier(session: TuiTestSession): Promise<void> {
    await session.waitForVisiblePaneWhere(
        (pane) => pane.includes("V  E  R  A") || pane.includes("Start a conversation with Vera"),
        "Home or conversation",
    );
    session.sendKey("C-p");
    await session.waitForVisiblePane("Commands");
    session.sendText("assign model");
    await session.waitForVisiblePane("Assign model defaults");
    session.sendKey("Enter");
    await session.waitForVisiblePane("classifier");
    session.sendKey("Down");
    session.sendKey("Down");
    session.sendKey("Down");
    session.sendKey("Enter");
    await session.waitForVisiblePane("Assign a model to classifier");
}

for (const attached of [false, true]) {
    for (const route of ["settings", "defaults"] as const) {
        test(`${!attached && route === "settings" ? "@core " : ""}${attached ? "conversation" : "Home"} ${route} saves classifier effort and retains failsafe`, async () => {
            const { session, configPath, operations, restorePool } = await startClassifierSession(attached);
            try {
                if (route === "settings") await openSettingsClassifier(session);
                else await openDefaultsClassifier(session);
                session.sendText("Reasoner");
                session.sendKey("Enter");
                const picker = await session.waitForVisiblePane("Reasoning");
                expect(picker).toContain("Low");
                expect(picker).toContain("High");
                expect(picker).not.toContain("Medium");
                expect(declared(configPath).map((entry) => entry.model)).toEqual(["cove/prior", "cove/backup"]);
                session.sendKey("Up");
                session.sendKey("Enter");
                await session.waitForVisiblePaneWhere(() => declared(configPath)[0]?.model === "cove/reason", "classifier saved");
                expect(declared(configPath).map(({ model, reasoning_effort }) => ({ model, reasoning_effort }))).toEqual([
                    { model: "cove/reason", reasoning_effort: "low" },
                    { model: "cove/backup", reasoning_effort: "high" },
                ]);
                expect(session.captureVisiblePane()).not.toContain("There is no conversation open yet");
                if (route === "settings") expect(operations).not.toContain("keep");
            } finally {
                await session.close();
                restorePool();
            }
        }, 20_000);
    }
}

for (const failsafe of ["Plain", "Reasoner"] as const) {
    test(`@core Home settings clears the classifier and refuses ${failsafe} as a failsafe without a primary`, async () => {
        const { session, configPath, operations, restorePool } = await startClassifierSession();
        try {
            await openSettingsClassifier(session);
            session.sendText("Use the session model");
            await session.waitForVisiblePane("Use the session model");
            session.sendKey("Enter");
            await session.waitForVisiblePaneWhere(
                () => loadVeraConfig({ path: configPath }).model_assignments?.reviewer === undefined,
                "classifier assignment cleared",
            );
            await session.waitForVisiblePaneWhere(
                (pane) => pane.includes("Primary") && pane.includes("Failsafe") && !pane.includes("Use the session model"),
                "classifier slots",
            );
            const cleared = readFileSync(configPath, "utf8");
            const before = statSync(configPath, { bigint: true });
            expect(JSON.parse(cleared).model_assignments?.reviewer).toBeUndefined();

            session.sendKey("Down");
            session.sendKey("Enter");
            await session.waitForVisiblePane(failsafe);
            session.sendText(failsafe);
            session.sendKey("Enter");
            if (failsafe === "Reasoner") {
                await session.waitForVisiblePane("Reasoning");
                expect(readFileSync(configPath, "utf8")).toBe(cleared);
                session.sendKey("Enter");
            }
            await session.waitForVisiblePane("Assign the classifier before choosing its failsafe.");
            const after = statSync(configPath, { bigint: true });
            expect(readFileSync(configPath, "utf8")).toBe(cleared);
            expect({ ino: after.ino, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs }).toEqual({
                ino: before.ino, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs,
            });
            expect(operations).toEqual([]);
        } finally {
            await session.close();
            restorePool();
        }
    }, 20_000);
}

for (const route of ["settings", "defaults"] as const) {
    test(`${route} verifies the model after effort selection before saving`, async () => {
        const gate = Promise.withResolvers<void>();
        const { session, configPath, operations, restorePool } = await startClassifierSession(false, gate.promise);
        try {
            if (route === "settings") await openSettingsClassifier(session);
            else await openDefaultsClassifier(session);
            session.sendText("Reasoner");
            session.sendKey("Enter");
            await session.waitForVisiblePane("Reasoning");
            session.sendKey("Up");
            session.sendKey("Enter");
            await session.waitForVisiblePane("Verifying model before assignment");
            expect(declared(configPath).map((entry) => entry.model)).toEqual(["cove/prior", "cove/backup"]);
            gate.resolve();
            await session.waitForVisiblePaneWhere(() => declared(configPath)[0]?.model === "cove/reason", "verified classifier saved");
            expect(declared(configPath).map(({ model, reasoning_effort }) => ({ model, reasoning_effort }))).toEqual([
                { model: "cove/reason", reasoning_effort: "low" },
                { model: "cove/backup", reasoning_effort: "high" },
            ]);
            expect(operations.filter((operation) => operation === "verify")).toHaveLength(1);
        } finally {
            gate.resolve();
            await session.close();
            restorePool();
        }
    }, 20_000);
}

for (const route of ["settings", "defaults"] as const) {
    test(`Escape from ${route} classifier effort returns to the model search without saving`, async () => {
        const { session, configPath, restorePool } = await startClassifierSession();
        try {
            if (route === "settings") await openSettingsClassifier(session);
            else await openDefaultsClassifier(session);
            session.sendText("Reasoner");
            session.sendKey("Enter");
            await session.waitForVisiblePane("Reasoning");
            session.sendKey("Escape");
            await session.waitForVisiblePane("Reasoner");
            expect(session.captureVisiblePane()).toContain("Reasoner");
            expect(declared(configPath).map((entry) => entry.model)).toEqual(["cove/prior", "cove/backup"]);
            session.sendKey("Escape");
            expect(declared(configPath).map((entry) => entry.model)).toEqual(["cove/prior", "cove/backup"]);
        } finally {
            await session.close();
            restorePool();
        }
    }, 20_000);
}

test("the failsafe effort step changes only the failsafe", async () => {
    const { session, configPath, restorePool } = await startClassifierSession();
    try {
        await openSettingsClassifier(session, "fallback");
        session.sendText("Reasoner");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Reasoning");
        expect(declared(configPath).map((entry) => entry.model)).toEqual(["cove/prior", "cove/backup"]);
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(() => declared(configPath)[1]?.model === "cove/reason", "failsafe saved");
        expect(declared(configPath).map(({ model, reasoning_effort }) => ({ model, reasoning_effort }))).toEqual([
            { model: "cove/prior", reasoning_effort: "low" },
            { model: "cove/reason", reasoning_effort: "high" },
        ]);
    } finally {
        await session.close();
        restorePool();
    }
}, 20_000);

for (const route of ["settings", "defaults"] as const) {
    test(`${route} saves a classifier model without levels directly`, async () => {
        const { session, configPath, restorePool } = await startClassifierSession();
        try {
            if (route === "settings") await openSettingsClassifier(session);
            else await openDefaultsClassifier(session);
            session.sendText("Plain");
            session.sendKey("Enter");
            await session.waitForVisiblePaneWhere(() => declared(configPath)[0]?.model === "cove/plain", "plain classifier saved");
            expect(declared(configPath).map(({ model, reasoning_effort }) => ({ model, reasoning_effort }))).toEqual([
                { model: "cove/plain", reasoning_effort: undefined },
                { model: "cove/backup", reasoning_effort: "high" },
            ]);
            expect(session.captureVisiblePane()).not.toContain("Reasoning");
        } finally {
            await session.close();
            restorePool();
        }
    }, 20_000);
}
