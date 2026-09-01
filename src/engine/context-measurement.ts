import type {
    AssistantMessage,
    ModelMessage,
    ModelTool,
    ModelUsage,
} from "../model/types.ts";
import {
    apportionPartTokens,
    type ContextPartSeed,
    type ContextProjectionPart,
} from "./context-parts.ts";
import type { ProjectedModelRequest } from "./model-request.ts";
import type { PromptContribution } from "./prompt-contributions.ts";

export type {
    ContextPartScope,
    ContextProjectionPart,
} from "./context-parts.ts";

export interface ContextMeasurement {
    readonly tokens: number;
    readonly capacity?: number;
    readonly estimated: boolean;
    readonly overheadTokens?: number;
    readonly projection?: ContextProjectionMeasurement;
    readonly compaction?: ContextCompactionMeasurement;
}

export interface ContextProjectionComponent {
    readonly kind: "prompt_contribution" | "tool_schema" | "message";
    readonly id: string;
    readonly owner: string;
    readonly source: string;
    readonly displayName: string;
    readonly count: number;
    readonly estimatedTokens: number;
    readonly parts?: readonly ContextProjectionPart[];
}

export interface ContextProjectionMeasurement {
    readonly estimatedTokens: number;
    readonly components: readonly ContextProjectionComponent[];
}

export interface ContextCompactionMeasurement {
    readonly triggerFraction?: number;
    readonly triggerTokens?: number;
}

const CHARACTERS_PER_TOKEN = 4;

const TOKENS_PER_MESSAGE = 4;

export function measureProjectedRequest(
    request: ProjectedModelRequest,
    capacity?: number,
    options: {
        readonly promptContributions?: readonly PromptContribution[];
        readonly compaction?: ContextCompactionMeasurement;
        readonly extensionToolNames?: readonly string[];
        readonly contributionParts?: Readonly<Record<string, readonly ContextPartSeed[]>>;
    } = {},
): ContextMeasurement {
    const extensionToolNames = new Set(options.extensionToolNames ?? []);
    const parts = [
        ...systemParts(request.systemPrompt, options.promptContributions),
        ...request.tools.map((tool) => ({
            kind: "tool_schema" as const,
            id: `tool:${tool.name}`,
            owner: extensionToolNames.has(tool.name) ? "extension" : "engine",
            source: "tool",
            displayName: tool.name,
            count: 1,
            characters: measureTool(tool),
            fixedTokens: 0,
        })),
        ...request.messages.map((message, index) => ({
            kind: "message" as const,
            id: `message:${index + 1}`,
            owner: "session",
            source: message.role,
            displayName: messageDisplayName(message, request.messages),
            count: 1,
            characters: measureMessage(message),
            fixedTokens: TOKENS_PER_MESSAGE,
        })),
    ];
    const characters = parts.reduce((total, part) => total + part.characters, 0);
    const tokens = Math.ceil(characters / CHARACTERS_PER_TOKEN)
        + request.messages.length * TOKENS_PER_MESSAGE;
    return {
        tokens,
        ...(capacity === undefined ? {} : { capacity }),
        estimated: true,
        ...(options.promptContributions === undefined
            ? {}
            : {
                projection: {
                    estimatedTokens: tokens,
                    components: reconcileParts(
                        parts,
                        tokens,
                        options.contributionParts ?? {},
                    ),
                },
            }),
        ...(options.compaction === undefined
            ? {}
            : { compaction: options.compaction }),
    };
}

export function measureMessages(messages: readonly ModelMessage[]): number {
    let characters = 0;
    for (const message of messages) {
        characters += measureMessage(message);
    }
    return Math.ceil(characters / CHARACTERS_PER_TOKEN)
        + messages.length * TOKENS_PER_MESSAGE;
}

export function measureCompletedAssistant(message: AssistantMessage): number {
    return Math.max(
        measureMessages([message]),
        message.usage.outputTokens > 0
            ? message.usage.outputTokens + TOKENS_PER_MESSAGE
            : 0,
    );
}

export function measureReportedUsage(
    usage: ModelUsage,
    capacity?: number,
): ContextMeasurement | undefined {
    if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens <= 0) {
        return undefined;
    }
    return {
        tokens: usage.inputTokens,
        ...(capacity === undefined ? {} : { capacity }),
        estimated: false,
    };
}

export function isContextMeasurement(
    value: unknown,
): value is ContextMeasurement {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const measurement = value as Record<string, unknown>;
    const tokens = measurement.tokens;
    const projection = measurement.projection;
    return Number.isSafeInteger(tokens)
        && (measurement.tokens as number) >= 0
        && (measurement.capacity === undefined
            || (Number.isSafeInteger(measurement.capacity)
                && (measurement.capacity as number) > 0))
        && (measurement.overheadTokens === undefined
            || (Number.isSafeInteger(measurement.overheadTokens)
                && (measurement.overheadTokens as number) >= 0))
        && typeof measurement.estimated === "boolean"
        && isProjection(projection)
        && (projection === undefined
            || (
                projection.estimatedTokens === tokens
                && projection.components.reduce(
                    (total, component) => total + component.estimatedTokens,
                    0,
                ) === tokens
            ))
        && isCompaction(measurement.compaction);
}

interface MeasuredPart {
    readonly kind: ContextProjectionComponent["kind"];
    readonly id: string;
    readonly owner: string;
    readonly source: string;
    readonly displayName: string;
    readonly count: number;
    readonly characters: number;
    readonly fixedTokens: number;
}

function systemParts(
    systemPrompt: string,
    contributions: readonly PromptContribution[] | undefined,
): readonly MeasuredPart[] {
    if (contributions === undefined || contributions.length === 0) {
        return [{
            kind: "prompt_contribution",
            id: "system.prompt",
            owner: "engine",
            source: "system",
            displayName: "System prompt",
            count: 1,
            characters: systemPrompt.length,
            fixedTokens: 0,
        }];
    }
    return contributions.map((contribution, index) => ({
        kind: "prompt_contribution",
        id: contribution.id,
        owner: contribution.owner,
        source: contribution.target,
        displayName: safeContributionDisplayName(contribution),
        count: 1,
        characters: renderContribution(contribution).length
            + (index === 0 ? 0 : 2),
        fixedTokens: 0,
    }));
}

function renderContribution(contribution: PromptContribution): string {
    return `## ${contribution.title}\n${contribution.content}`;
}

function safeContributionDisplayName(
    contribution: PromptContribution,
): string {
    const title = contribution.title.trim();
    if (
        title.length === 0
        || title.length > 80
        || /[\\/\u0000-\u001f\u007f]/u.test(title)
    ) {
        return "Prompt contribution";
    }
    return title;
}

function reconcileParts(
    parts: readonly MeasuredPart[],
    totalTokens: number,
    contributionParts: Readonly<Record<string, readonly ContextPartSeed[]>>,
): readonly ContextProjectionComponent[] {
    if (parts.length === 0) return [];
    const raw = parts.reduce((total, part) => total + part.characters, 0);
    const fixedTokens = parts.reduce(
        (total, part) => total + part.fixedTokens,
        0,
    );
    const characterTokens = Math.max(0, totalTokens - fixedTokens);
    let assignedCharacterTokens = 0;
    const components = parts.map((part, index) => {
        const proportional = raw === 0
            ? 0
            : Math.floor(characterTokens * part.characters / raw);
        const allocatedCharacterTokens = index === parts.length - 1
            ? characterTokens - assignedCharacterTokens
            : proportional;
        assignedCharacterTokens += allocatedCharacterTokens;
        const estimatedTokens = part.fixedTokens + allocatedCharacterTokens;
        const seeds = contributionParts[part.id];
        return {
            kind: part.kind,
            id: part.id,
            owner: part.owner,
            source: part.source,
            displayName: part.displayName,
            count: part.count,
            estimatedTokens,
            ...(seeds === undefined || seeds.length === 0
                ? {}
                : { parts: apportionPartTokens(seeds, estimatedTokens) }),
        } satisfies ContextProjectionComponent;
    });
    return components;
}

export function scaleProjectionTo(
    projection: ContextProjectionMeasurement,
    targetTokens: number,
): ContextProjectionMeasurement {
    const fromTotal = projection.components.reduce(
        (total, component) => total + component.estimatedTokens,
        0,
    );
    if (
        projection.estimatedTokens === targetTokens
        && fromTotal === targetTokens
    ) {
        return projection;
    }
    const scaleFrom = fromTotal > 0 ? fromTotal : projection.estimatedTokens;
    const components = scaleTokenShares(
        projection.components,
        scaleFrom,
        targetTokens,
    );
    return {
        estimatedTokens: targetTokens,
        components: components.map((component, index) => {
            const original = projection.components[index];
            if (original?.parts === undefined) return component;
            return {
                ...component,
                parts: scaleTokenShares(
                    original.parts,
                    original.estimatedTokens,
                    component.estimatedTokens,
                ),
            };
        }),
    };
}

function scaleTokenShares<T extends { readonly estimatedTokens: number }>(
    items: readonly T[],
    fromTotal: number,
    toTotal: number,
): T[] {
    if (items.length === 0) return [];
    let assigned = 0;
    return items.map((item, index) => {
        const estimatedTokens = index === items.length - 1
            ? Math.max(0, toTotal - assigned)
            : fromTotal <= 0
                ? 0
                : Math.floor(item.estimatedTokens * toTotal / fromTotal);
        assigned += estimatedTokens;
        return { ...item, estimatedTokens };
    });
}

function isProjection(value: unknown): value is ContextProjectionMeasurement | undefined {
    if (value === undefined) return true;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const projection = value as Record<string, unknown>;
    return Number.isSafeInteger(projection.estimatedTokens)
        && (projection.estimatedTokens as number) >= 0
        && Array.isArray(projection.components)
        && projection.components.every(isProjectionComponent);
}

function isProjectionComponent(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const component = value as Record<string, unknown>;
    return (component.kind === "prompt_contribution"
        || component.kind === "tool_schema"
        || component.kind === "message")
        && typeof component.id === "string"
        && typeof component.owner === "string"
        && typeof component.source === "string"
        && typeof component.displayName === "string"
        && Number.isSafeInteger(component.count)
        && (component.count as number) >= 0
        && Number.isSafeInteger(component.estimatedTokens)
        && (component.estimatedTokens as number) >= 0
        && isProjectionParts(component.parts);
}

function isProjectionParts(value: unknown): boolean {
    if (value === undefined) return true;
    if (!Array.isArray(value)) return false;
    return value.every((part) => {
        if (typeof part !== "object" || part === null || Array.isArray(part)) {
            return false;
        }
        const entry = part as Record<string, unknown>;
        return typeof entry.id === "string"
            && typeof entry.displayName === "string"
            && (entry.scope === "project"
                || entry.scope === "user"
                || entry.scope === "agent"
                || entry.scope === "memory"
                || entry.scope === "skill")
            && Number.isSafeInteger(entry.bytes)
            && (entry.bytes as number) >= 0
            && Number.isSafeInteger(entry.estimatedTokens)
            && (entry.estimatedTokens as number) >= 0
            && (entry.imported === undefined || entry.imported === true);
    });
}

function isCompaction(value: unknown): value is ContextCompactionMeasurement | undefined {
    if (value === undefined) return true;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const compaction = value as Record<string, unknown>;
    return (compaction.triggerFraction === undefined
        || (typeof compaction.triggerFraction === "number"
            && Number.isFinite(compaction.triggerFraction)
            && compaction.triggerFraction > 0
            && compaction.triggerFraction <= 1))
        && (compaction.triggerTokens === undefined
            || (Number.isSafeInteger(compaction.triggerTokens)
                && (compaction.triggerTokens as number) > 0));
}

function measureTool(tool: ModelTool): number {
    return tool.name.length
        + tool.description.length
        + JSON.stringify(tool.inputSchema).length;
}

function messageDisplayName(
    message: ModelMessage,
    messages: readonly ModelMessage[],
): string {
    if (message.role !== "tool_result") {
        return `${message.role} message`;
    }
    const name = safeToolLabel(message.toolName);
    const path = toolResultPath(message.toolCallId, messages);
    return path === undefined ? `${name} result` : `${name} ${path}`;
}

function toolResultPath(
    toolCallId: string,
    messages: readonly ModelMessage[],
): string | undefined {
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
            if (block.type !== "tool_call" || block.id !== toolCallId) continue;
            const path = block.input.path;
            if (typeof path !== "string") return undefined;
            return safeToolLabel(basename(path));
        }
    }
    return undefined;
}

function basename(path: string): string {
    const trimmed = path.trim();
    const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function safeToolLabel(value: string): string {
    const label = value.trim();
    if (
        label.length === 0
        || label.length > 80
        || /[\\/\u0000-\u001f\u007f]/u.test(label)
    ) {
        return "tool";
    }
    return label;
}

function measureMessage(message: ModelMessage): number {
    if (message.role === "tool_result") {
        return message.toolName.length
            + sum(message.content, (block) => block.text.length);
    }
    if (message.role === "user") {
        return sum(
            message.content,
            (block) => block.type === "text" ? block.text.length : 0,
        );
    }
    return sum(message.content, (block) => {
        if (block.type === "text" || block.type === "thinking") {
            return block.text.length;
        }
        return block.name.length + JSON.stringify(block.input).length;
    });
}

function sum<T>(items: readonly T[], size: (item: T) => number): number {
    return items.reduce((total, item) => total + size(item), 0);
}

export function measureToolResultBytes(
    messages: readonly ModelMessage[],
): number {
    let bytes = 0;
    for (const message of messages) {
        if (message.role !== "tool_result") {
            continue;
        }
        for (const block of message.content) {
            bytes += Buffer.byteLength(block.text, "utf8");
        }
    }
    return bytes;
}
