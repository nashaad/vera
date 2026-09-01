import { loadOptionalVeraConfig } from "../../../src/config.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { defaultFailureReportDirectory, failureReportMarkdown, failureReportOneshotInput, writeFailureReport } from "../../../src/store/failure-report.ts";
import { defaultModelFailureLedgerPath, modelFailureNudge, readModelFailures, summariseModelFailures } from "../../../src/store/model-failures.ts";
import { defaultStashRoot, summarizeStash } from "../../../src/store/preimage-stash.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { renderTuiDiagnostics, type TuiDiagnosticsSnapshot } from "../diagnostics.ts";
import type { DialogRowPointer } from "../dialog-chrome.ts";
import { isHomeClient } from "../home-client.ts";
import { readLatestHostStartupTiming } from "../host-startup-diagnostics.ts";
import { FAILURE_REPORT_PROMPT, FAILURE_REPORT_SUMMARY_TOKENS, POINTER_HOVER_DELAY_MS, elapsedWorkingTime, raisedModelFailureSignatures, renderState, reportConnectionError, requestExtensionOneshot, requireIdentifiedClient } from "../main.ts";
import { openExtensionAgent } from "../main/agents-dials.ts";
import { handleKeypress } from "../main/keypress.ts";
import { admitHealthRung, expiredOAuthProvider, hasConfiguredProvider, healthRungsOf, runProviderHealthCheck, type HealthRung } from "../provider-health.ts";
import { appendTuiError, appendTuiNotice, type TuiState } from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { KeyEvent } from "@opentui/core";
import { randomUUID } from "node:crypto";

export function pressKey(rt: TuiRuntime, name: string, sequence = name): void {
    handleKeypress(rt, new KeyEvent({
        name,
        sequence,
        raw: sequence,
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        number: /^[0-9]$/.test(sequence),
        eventType: "press",
        source: "raw",
    }));
}

export function rowPointer(rt: TuiRuntime, 
    moveCursor: (index: number) => void,
    key: "return" | "digit" = "return",
): DialogRowPointer {
    if (key === "digit") {
        return { activate: (index) => pressKey(rt, String(index)) };
    }
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    return {
        hover: (index) => {
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                hoverTimer = undefined;
                if (rt.shuttingDown) return;
                moveCursor(index);
                renderState(rt);
            }, POINTER_HOVER_DELAY_MS);
        },
        activate: (index) => {
            clearTimeout(hoverTimer);
            hoverTimer = undefined;
            moveCursor(index);
            pressKey(rt, "return", "\r");
        },
    };
}

export function requestAgentSettings(rt: TuiRuntime, target: TuiAgentClient): void {
    if (target.failed === true) {
        return;
    }
    const home = isHomeClient(target);
    if (target.viewOnly === true && !home) {
        return;
    }
    void target.send({
        type: "get_model_settings",
        requestId: randomUUID(),
    }).catch(((error: unknown) => reportConnectionError(rt, error)));
    if (home) {
        return;
    }
    void target.send({
        type: "get_permissions",
        requestId: randomUUID(),
    }).catch(((error: unknown) => reportConnectionError(rt, error)));
}

export function retryMissingAgentSettings(rt: TuiRuntime, 
    target: TuiAgentClient,
    snapshot: TuiState,
): void {
    if (
        snapshot.modelSettings !== undefined
        && snapshot.approvalMode !== undefined
    ) {
        return;
    }
    const used = rt.settingsSnapshotRetries.get(target) ?? 0;
    if (used >= rt.MAX_SETTINGS_SNAPSHOT_RETRIES) {
        return;
    }
    rt.settingsSnapshotRetries.set(target, used + 1);
    requestAgentSettings(rt, target);
}

export function isSettingsRetryTrigger(rt: TuiRuntime, update: AgentUpdate): boolean {
    return update.type === "history"
        || update.type === "context"
        || update.type === "turn_finished"
        || (update.type === "status" && update.state === "idle");
}

export function requestSessionSettings(rt: TuiRuntime): void {
    requestAgentSettings(rt, rt.client);
}

export async function restorePersistedAgentPane(rt: TuiRuntime): Promise<void> {
    const mainAgentId = rt.client.agentId;
    if (rt.dependencies.attachAgent === undefined) return;
    try {
        await rt.hostedPanePersistence.restore(mainAgentId, {
            attach: async (agentId) =>
                requireIdentifiedClient(
                    await rt.dependencies.attachAgent!(agentId),
                ),
            isCurrent: () =>
                !rt.shuttingDown && rt.client.agentId === mainAgentId,
            adopt: (saved, next) =>
                openExtensionAgent(rt, 
                    saved.owner,
                    next,
                    "sidebar",
                    false,
                    saved.mention,
                    "durable",
                    undefined,
                    saved.statusLabel,
                ),
        });
    } catch (error) {
        if (rt.shuttingDown || rt.client.agentId !== mainAgentId) return;
        rt.state = appendTuiError(
            rt.state,
            `Could not restore paired pane: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        renderState(rt);
    }
}

export function diagnosticsSnapshot(rt: TuiRuntime): TuiDiagnosticsSnapshot {
    return {
        state: rt.state,
        activity: rt.activity,
        elapsed: elapsedWorkingTime(rt),
        scope: rt.diagnosticsScope,
        sessionId: rt.client.agentId,
        sessionIdentity: rt.diagnosticsSessionIdentity,
        sessionPath: rt.diagnosticsSessionPath,
        workspace: rt.client.workspace ?? process.cwd(),
        runningBackgroundAgents: rt.runningBackgroundAgents,
        processes: [
            { role: "client" as const, pid: process.pid },
            ...(rt.dependencies.build?.hostPid === undefined
                ? []
                : [{ role: "host" as const, pid: rt.dependencies.build.hostPid }]),
            ...(rt.diagnosticsWorkerPid === undefined
                ? []
                : [{ role: "worker" as const, pid: rt.diagnosticsWorkerPid }]),
            ...(rt.diagnosticsSupervisorPid === undefined
                ? []
                : [{ role: "supervisor" as const, pid: rt.diagnosticsSupervisorPid }]),
        ].map((entry) => ({
            ...entry,
            ...(rt.diagnosticsProcessMemory.get(entry.pid) === undefined
                ? {}
                : { rssBytes: rt.diagnosticsProcessMemory.get(entry.pid) }),
        })),
        stash: summarizeStash(),
        stashRoot: defaultStashRoot(),
        modelFailures: summariseModelFailures(readModelFailures()),
        modelFailureLedgerPath: defaultModelFailureLedgerPath(),
        build: rt.dependencies.build,
        extensions: rt.configuredClientExtensions,
        clientExtensionReload: rt.clientExtensionReload,
        startup: readLatestHostStartupTiming(),
        health: rt.providerHealth,
        healthLineWidth: rt.diagnosticsDialogView.contentWidth(),
    };
}

export function renderDiagnostics(rt: TuiRuntime, 
    snapshot = diagnosticsSnapshot(rt),
): string {
    const width = rt.diagnosticsDialogView.contentWidth();
    rt.diagnosticsReportWidth = width;
    return renderTuiDiagnostics(snapshot, width);
}

export function abortProviderHealthCheck(rt: TuiRuntime): void {
    rt.providerHealthAbort?.abort();
    rt.providerHealthAbort = undefined;
}

export function paintDiagnosticsDialog(rt: TuiRuntime): void {
    if (rt.diagnosticsDialog === undefined) return;
    rt.diagnosticsDialog = {
        ...rt.diagnosticsDialog,
        text: renderDiagnostics(rt),
        scope: rt.diagnosticsScope,
    };
}

export async function startProviderHealthCheck(rt: TuiRuntime): Promise<void> {
    if (rt.diagnosticsDialog === undefined) return;
    if (rt.providerHealth.kind === "checking") return;
    const generation = ++rt.providerHealthGeneration;
    abortProviderHealthCheck(rt);
    const abort = new AbortController();
    rt.providerHealthAbort = abort;
    const config = loadOptionalVeraConfig();
    const rungs = healthRungsOf(rt.state.modelSettings, config);
    const configured = hasConfiguredProvider(
        rt.authStorage,
        config,
        rt.dependencies.healthEnv ?? process.env,
    );
    const expired = expiredOAuthProvider(rt.authStorage);
    const probe = rt.dependencies.probeHealthRung
        ?? ((rung: HealthRung, signal: AbortSignal) =>
            admitHealthRung(rung, {
                authStorage: rt.authStorage,
                signal,
                ...(config === undefined ? {} : { config }),
            }));
    await runProviderHealthCheck({
        rungs,
        configured,
        ...(expired === undefined ? {} : { expiredCredential: expired }),
        probe,
        signal: abort.signal,
        onProgress: (status) => {
            if (
                rt.shuttingDown
                || rt.diagnosticsDialog === undefined
                || rt.providerHealthGeneration !== generation
            ) {
                return;
            }
            rt.providerHealth = status;
            paintDiagnosticsDialog(rt);
            renderState(rt);
        },
    });
}

export function noticeRepeatedModelFailure(rt: TuiRuntime, current: TuiState): TuiState {
    const nudge = modelFailureNudge(
        readModelFailures(),
        raisedModelFailureSignatures,
    );        if (nudge === undefined) return current;
    raisedModelFailureSignatures.add(nudge.signature);
    return appendTuiNotice(current, nudge.text, "soft");
}

export async function writeFailureReportFile(rt: TuiRuntime): Promise<void> {
    const records = readModelFailures();
    if (records.length === 0) {
        rt.state = appendTuiNotice(
            rt.state,
            "No model failures have been recorded.",
            "soft",
        );
        renderState(rt);
        return;
    }
    const settings = rt.state.modelSettings;
    const failing = settings !== undefined
        && records.some((record) =>
            record.model === settings.model
            && (settings.provider === undefined
                || record.provider === settings.provider)
        );
    let summary: string | undefined;
    let note: string | undefined;
    if (settings === undefined) {
        note = "No model is running, so the report has no summary.";
    } else if (failing) {
        note = `Summary skipped: ${settings.model} is the model that is`
            + ` failing. Switch with /model, then run /failure-report`
            + ` again.`;
    } else {
        try {
            const result = await requestExtensionOneshot(rt, {
                model: settings.model,
                ...(settings.provider === undefined
                    ? {}
                    : { provider: settings.provider }),
                systemPrompt: FAILURE_REPORT_PROMPT,
                messages: [{
                    role: "user",
                    content: failureReportOneshotInput(records),
                }],
                maxTokens: FAILURE_REPORT_SUMMARY_TOKENS,
            }, new AbortController().signal);
            summary = result.text;
        } catch (error) {
            note = `No summary: ${
                error instanceof Error ? error.message : String(error)
            }`;
        }
    }
    const at = new Date();
    try {
        const path = writeFailureReport(
            defaultFailureReportDirectory(),
            failureReportMarkdown({
                records,
                at,
                ...(summary === undefined ? {} : { summary }),
            }),
            at,
        );
        rt.state = appendTuiNotice(
            rt.state,
            note === undefined
                ? `Failure report written to ${path}`
                : `Failure report written to ${path}. ${note}`,
            "soft",
        );
    } catch (error) {
        rt.state = appendTuiError(
            rt.state,
            `Could not write the failure report: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    renderState(rt);
}
