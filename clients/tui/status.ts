import { homedir } from "node:os";

import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { TuiEffortSubstitution } from "./state.ts";
import type {
    StatusLineSegment,
    StatusLineSnapshot,
} from "../../src/extensions/status-line.ts";
import { findProvider } from "../../src/providers/registry.ts";

/**
 * The facts the extension surface is handed on every repaint. Built here
 * rather than in the render pass so the snapshot stays plain data, with no
 * renderable, no session, and no client state hanging off it.
 */
export function tuiStatusSnapshot(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    context: ContextMeasurement | undefined,
    workspace: string,
    runningBackgroundAgents: number,
    turn: StatusLineSnapshot["turn"],
): StatusLineSnapshot {
    return {
        version: 1,
        turn,
        workspace,
        runningBackgroundAgents,
        ...(settings === undefined ? {} : {
            model: {
                model: settings.model,
                ...(settings.provider === undefined
                    ? {}
                    : { provider: settings.provider }),
                ...(settings.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: settings.reasoningEffort }),
            },
        }),
        ...(approvalMode === undefined ? {} : { approvalMode }),
        ...(context === undefined ? {} : {
            context: {
                tokens: context.tokens,
                estimated: context.estimated,
                ...(context.capacity === undefined
                    ? {}
                    : { capacity: context.capacity }),
            },
        }),
    };
}

/**
 * Segments carry facts, not wording. Every phrase below is the TUI's own
 * choice, so an extension reordering or dropping segments never changes how
 * this client says a thing. An unknown kind cannot reach here: the registry
 * refuses to parse it.
 */
export function renderTuiStatusSegments(
    segments: readonly StatusLineSegment[],
): string {
    return segments
        .map((segment) => renderTuiStatusSegment(segment))
        .filter((text) => text.length > 0)
        .join(" · ");
}

function renderTuiStatusSegment(segment: StatusLineSegment): string {
    switch (segment.kind) {
        case "model": {
            const label = segment.provider === undefined
                ? undefined
                : findProvider(segment.provider)?.shortLabel;
            const model = label === undefined
                ? segment.model
                : `${label}/${segment.model}`;
            return segment.reasoningEffort === undefined
                ? model
                : `${model} · reasoning ${segment.reasoningEffort}`;
        }
        case "context":
            return segment.capacity === undefined
                ? ""
                : contextUsage(
                    segment.tokens,
                    segment.capacity,
                    segment.estimated === true,
                );
        case "permissions":
            return renderPermissions(segment.mode);
        case "workspace":
            return compactWorkspace(segment.path);
        case "background_agents":
            return segment.running === 0
                ? ""
                : `${segment.running} async subagent${
                    segment.running === 1 ? "" : "s"
                } running`;
        case "turn":
            return segment.state === "idle" ? "" : segment.state;
        case "free_note":
            return segment.text;
    }
}

export function renderTuiStatusDetailsLine(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    context: ContextMeasurement | undefined,
    workspace: string,
    runningBackgroundAgents = 0,
    substitution: TuiEffortSubstitution | undefined = undefined,
): string {
    const providerLabel = settings?.provider === undefined
        ? undefined
        : findProvider(settings.provider)?.shortLabel;
    const model = settings?.model === undefined
        ? "loading"
        : providerLabel === undefined
            ? settings.model
            : `${providerLabel}/${settings.model}`;
    const requested = settings?.reasoningEffort ?? "default";
    // Requested → effective, and only while the evidence covers the model and
    // the level in effect. The setting itself is untouched: the arrow is what
    // says the two disagree, rather than the dial quietly moving.
    const substituted = substitution !== undefined
        && settings?.model === substitution.model
        && requested === substitution.requested;
    // What is running now, with what was asked for behind it: this line
    // reports the session as it stands, so the effective level leads and the
    // request is the annotation on it.
    const thinking = settings === undefined
        ? "loading"
        : substituted
            ? `${substitution!.effective ?? "none"} (asked ${requested})`
            : requested;
    const permissions = approvalMode === undefined
        ? "permissions loading"
        : renderPermissions(approvalMode);
    const usage = renderContextUsage(context);
    const background = runningBackgroundAgents === 0
        ? ""
        : `${runningBackgroundAgents} async subagent${
            runningBackgroundAgents === 1 ? "" : "s"
        } running · `;
    return `${background}${model} · reasoning ${thinking} · ${compactWorkspace(workspace)} · ${permissions}${usage}`;
}

/**
 * The idle status line, which reports background work when there is any.
 *
 * An idle session with children still out looks identical to a finished one,
 * so the quiet is what needs explaining. The palette hint rides along because
 * the idle line is the only place that chord is advertised.
 */
export function renderTuiIdleHint(
    readyHint: string,
    runningBackgroundAgents: number,
): string {
    if (runningBackgroundAgents <= 0) {
        return readyHint;
    }
    const agents = `${runningBackgroundAgents} background agent${
        runningBackgroundAgents === 1 ? "" : "s"
    }`;
    return `waiting for ${agents} · ${readyHint}`;
}

export function countRunningBackgroundAgents(
    agents: readonly RegisteredAgentSummary[],
): number {
    // Running, not merely present and not merely live: every background
    // session the host restored at startup is present, and one being read
    // through an attachment is live, but neither is doing anything.
    return agents.filter((agent) =>
        agent.kind === "background"
        && (agent.status === "working" || agent.status === "waiting")
    ).length;
}

export function renderBackgroundAgentNames(
    agents: readonly RegisteredAgentSummary[],
    parentId: string | undefined,
): string {
    if (parentId === undefined) return "";
    return agents
        .filter((agent) =>
            agent.kind === "background"
            && agent.parent_id === parentId
            && (agent.status === "working" || agent.status === "waiting")
        )
        .map((agent) => `* ${agent.title ?? agent.id}`)
        .join("\n");
}

function compactWorkspace(workspace: string): string {
    const home = homedir();
    return workspace === home
        ? "~"
        : workspace.startsWith(`${home}/`)
            ? `~/${workspace.slice(home.length + 1)}`
            : workspace;
}

/**
 * Absent until the engine has measured something. A session that has not sent
 * a request has no honest percentage to show: its prompt and tool definitions
 * already occupy the window, so "0%" would be a number nobody measured.
 *
 * The tilde is the estimate label. Vera counts characters until a provider
 * reports its own total, and a percentage that hides which of the two it is
 * reads as precise when it is not.
 */
function renderContextUsage(context: ContextMeasurement | undefined): string {
    if (context?.capacity === undefined) return "";
    return ` · ${
        contextUsage(context.tokens, context.capacity, context.estimated)
    }`;
}

function contextUsage(
    tokens: number,
    capacity: number,
    estimated: boolean,
): string {
    const percent = Math.min(100, Math.round(tokens / capacity * 100));
    return `ctx ${estimated ? "~" : ""}${percent}%`;
}

function renderPermissions(mode: string): string {
    return mode === "full_access" ? "FULL ACCESS · RED ZONE" : mode;
}
