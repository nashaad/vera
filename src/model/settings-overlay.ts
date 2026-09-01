/**
 * Best-effort settings overlay: how to talk to a few well-known local models
 * when live listing is mute. Compiles into CatalogModel levels. Not a
 * guarantee and not an Outrider dialect.
 */

import { fileURLToPath } from "node:url";

import { shippedProviderIds } from "../providers/definitions.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";
import type { ReasoningLevel } from "./catalog-shape.ts";
import {
    EFFORT_LADDER,
    isEffortLevel,
    type EffortLevel,
    type EffortMap,
} from "./effort-ladder.ts";

export const SETTINGS_OVERLAY_SCHEMA_VERSION = 1;

const SHIPPED_OVERLAY_PATH = fileURLToPath(
    new URL("../../config/settings-overlay.json", import.meta.url),
);

export type OverlayDialect = "ollama" | "llama.cpp-openai";
export type OverlayRequestLayer =
    | "enable-thinking-kwargs"
    | "openai-reasoning-effort";

export interface OverlayThinking {
    readonly style: "enable_thinking" | "reasoning_effort";
    readonly request_layer: OverlayRequestLayer;
    readonly efforts: EffortMap;
    readonly omit_means: "on" | "off" | "unknown";
    readonly refuse_fields: readonly string[];
}

export interface OverlayProvenance {
    readonly docs_url: string;
    readonly date: string;
    readonly applies_to?: string;
}

export interface OverlayModel {
    readonly id: string;
    readonly dialect: OverlayDialect;
    readonly wire_id_match: readonly string[];
    readonly requires_live_thinking?: boolean;
    readonly thinking: OverlayThinking;
    readonly notes: readonly string[];
    readonly provenance: OverlayProvenance;
}

export interface SettingsOverlay {
    readonly schema_version: typeof SETTINGS_OVERLAY_SCHEMA_VERSION;
    readonly generated_at: string;
    readonly models: readonly OverlayModel[];
}

export interface JoinOverlayInput {
    readonly provider: string;
    readonly listingId: string;
    readonly liveThinking?: boolean;
    readonly overlay?: SettingsOverlay;
    readonly shippedIds?: readonly string[];
}

export function overlayDialectForProvider(
    provider: string,
    shippedIds: readonly string[] = shippedProviderIds(),
): OverlayDialect | undefined {
    if (provider === "ollama") return "ollama";
    if (shippedIds.includes(provider)) return undefined;
    return "llama.cpp-openai";
}

let shipped: SettingsOverlay | undefined;

export function loadShippedSettingsOverlay(
    path = SHIPPED_OVERLAY_PATH,
): SettingsOverlay | undefined {
    try {
        return parseSettingsOverlay(JSON.parse(readRegularFileTextSync(path)));
    } catch {
        return undefined;
    }
}

export function shippedSettingsOverlay(): SettingsOverlay | undefined {
    if (shipped === undefined) {
        shipped = loadShippedSettingsOverlay() ?? emptyOverlay();
    }
    return shipped.models.length === 0 ? undefined : shipped;
}

export function parseSettingsOverlay(value: unknown): SettingsOverlay | undefined {
    if (!isRecord(value)
        || value.schema_version !== SETTINGS_OVERLAY_SCHEMA_VERSION
        || typeof value.generated_at !== "string"
        || !Array.isArray(value.models)) {
        return undefined;
    }
    const models: OverlayModel[] = [];
    for (const entry of value.models) {
        const parsed = parseOverlayModel(entry);
        if (parsed === undefined) return undefined;
        models.push(parsed);
    }
    return {
        schema_version: SETTINGS_OVERLAY_SCHEMA_VERSION,
        generated_at: value.generated_at,
        models,
    };
}

export function joinSettingsOverlay(
    input: JoinOverlayInput,
): OverlayModel | undefined {
    const dialect = overlayDialectForProvider(input.provider, input.shippedIds);
    if (dialect === undefined) return undefined;
    const overlay = input.overlay ?? shippedSettingsOverlay();
    if (overlay === undefined) return undefined;
    const listing = input.listingId;
    for (const row of overlay.models) {
        if (row.dialect !== dialect) continue;
        if (dialect === "ollama" && input.liveThinking !== true) continue;
        if (row.requires_live_thinking === true && input.liveThinking !== true) {
            continue;
        }
        if (row.wire_id_match.some((pattern) => globCi(listing, pattern))) {
            return row;
        }
    }
    return undefined;
}

/** Catalog levels from an overlay row: Vera ids, provider wires, most capable first. */
export function overlayCatalogLevels(
    row: OverlayModel,
): readonly ReasoningLevel[] {
    const supported = EFFORT_LADDER.filter((level) => {
        const wire = row.thinking.efforts[level];
        return typeof wire === "string" && wire.length > 0;
    });
    return [...supported].reverse().map((level) => {
        const wire = row.thinking.efforts[level];
        return {
            id: level,
            label: overlayLevelLabel(level, row),
            ...(typeof wire === "string" && wire !== level ? { wire } : {}),
        };
    });
}

export function overlayLevelLabel(level: EffortLevel, row: OverlayModel): string {
    const supported = EFFORT_LADDER.filter((rung) => (
        typeof row.thinking.efforts[rung] === "string"
    ));
    if (row.thinking.style === "enable_thinking" && supported.length === 2) {
        if (level === "off") return "Think off";
        return "Think on";
    }
    if (level === "off") return "Off";
    return level.charAt(0).toUpperCase() + level.slice(1);
}

export function enableThinkingFromEffort(effort: string | undefined): boolean | undefined {
    if (effort === undefined) return undefined;
    if (effort === "off" || effort === "none" || effort === "false") return false;
    return true;
}

export function overlayWireForEffort(
    row: OverlayModel,
    effort: string | undefined,
): string | undefined {
    if (effort === undefined) return undefined;
    if (isEffortLevel(effort)) {
        const wire = row.thinking.efforts[effort];
        return typeof wire === "string" ? wire : undefined;
    }
    return undefined;
}

function globCi(listingId: string, pattern: string): boolean {
    return globToRegExp(pattern.toLowerCase()).test(listingId.toLowerCase());
}

const patternCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
    const cached = patternCache.get(pattern);
    if (cached !== undefined) return cached;
    const source = [...pattern].map((character) => {
        if (character === "*") return ".*";
        if (character === "?") return ".";
        return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }).join("");
    const expression = new RegExp(`^${source}$`);
    patternCache.set(pattern, expression);
    return expression;
}

function parseOverlayModel(value: unknown): OverlayModel | undefined {
    if (!isRecord(value)
        || typeof value.id !== "string"
        || (value.dialect !== "ollama" && value.dialect !== "llama.cpp-openai")
        || !Array.isArray(value.wire_id_match)
        || !value.wire_id_match.every((entry) => typeof entry === "string")
        || !isRecord(value.thinking)
        || (value.thinking.style !== "enable_thinking"
            && value.thinking.style !== "reasoning_effort")
        || (value.thinking.request_layer !== "enable-thinking-kwargs"
            && value.thinking.request_layer !== "openai-reasoning-effort")
        || !isRecord(value.thinking.efforts)
        || (value.thinking.omit_means !== "on"
            && value.thinking.omit_means !== "off"
            && value.thinking.omit_means !== "unknown")
        || !Array.isArray(value.thinking.refuse_fields)
        || !value.thinking.refuse_fields.every((entry) => typeof entry === "string")
        || !Array.isArray(value.notes)
        || !value.notes.every((entry) => typeof entry === "string")
        || !isRecord(value.provenance)
        || typeof value.provenance.docs_url !== "string"
        || typeof value.provenance.date !== "string") {
        return undefined;
    }
    const efforts: Record<string, string | null> = {};
    for (const [key, mapped] of Object.entries(value.thinking.efforts)) {
        if (!isEffortLevel(key)) return undefined;
        if (mapped !== null && typeof mapped !== "string") return undefined;
        efforts[key] = mapped;
    }
    return {
        id: value.id,
        dialect: value.dialect,
        wire_id_match: value.wire_id_match,
        ...(value.requires_live_thinking === true
            ? { requires_live_thinking: true }
            : {}),
        thinking: {
            style: value.thinking.style,
            request_layer: value.thinking.request_layer,
            efforts,
            omit_means: value.thinking.omit_means,
            refuse_fields: value.thinking.refuse_fields,
        },
        notes: value.notes,
        provenance: {
            docs_url: value.provenance.docs_url,
            date: value.provenance.date,
            ...(typeof value.provenance.applies_to === "string"
                ? { applies_to: value.provenance.applies_to }
                : {}),
        },
    };
}

function emptyOverlay(): SettingsOverlay {
    return {
        schema_version: SETTINGS_OVERLAY_SCHEMA_VERSION,
        generated_at: "1970-01-01",
        models: [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
