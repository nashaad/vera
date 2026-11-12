// A session's model, effort, shortlist and catalog, read from `model_settings` updates
// and from the host's own `model_settings` answer.

export interface Pricing {
    // Dollars per million tokens.
    readonly input: number;
    readonly output: number;
    readonly cache?: number;
}

export interface EffortLevel {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export interface ModelEntry {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    // The label without a "Vendor: " prefix, such as OpenRouter's "OpenAI: GPT-5.6 Luna". Set only
    // when it differs; a name the person gave the model is never shortened.
    readonly shortLabel?: string;
    // The prefix shortLabel drops, such as "OpenAI".
    readonly maker?: string;
    readonly description?: string;
    readonly contextWindow?: number;
    readonly pricing?: Pricing;
    readonly waScore?: number;
    readonly onPareto: boolean;
    readonly imageSupport?: boolean;
    readonly verified: boolean;
    readonly verificationError?: string;
    // Left out of the resting catalog list; a search still finds it.
    readonly hidden: boolean;
    readonly recommended: boolean;
    readonly levels: readonly EffortLevel[];
    readonly defaultLevel?: string;
    // False for a shortlisted model its provider no longer offers.
    readonly available: boolean;
}

export interface ModelChoice {
    readonly provider?: string;
    readonly model: string;
    readonly effort?: string;
}

export interface SubagentDefault {
    // "none": nothing is assigned and the parent's model is not allowed, so a spawn fails.
    readonly mode: "inherit" | "fixed" | "none";
    readonly choice?: ModelChoice;
}

export interface ReviewerDefault {
    readonly mode: "agent" | "fixed";
    readonly primary?: ModelChoice;
    readonly fallback?: ModelChoice;
}

export interface ProviderCatalog {
    readonly id: string;
    readonly label: string;
    readonly refreshedAt?: string;
}

export interface ModelSettings {
    readonly provider?: string;
    readonly model: string;
    readonly effort?: string;
    // What was asked for when the model cannot run that effort.
    readonly requestedEffort?: string;
    readonly efforts: readonly string[];
    readonly shortlist: readonly ModelEntry[];
    readonly catalog: readonly ModelEntry[];
    readonly contextWindow?: number;
    readonly subagentDefault?: SubagentDefault;
    readonly reviewerDefault?: ReviewerDefault;
    // Only the host's own answer lists connected providers.
    readonly providers?: readonly ProviderCatalog[];
}

export interface ModelSettingsReply {
    readonly requestId: string;
    readonly settings: ModelSettings;
    // Set while a change waits for the running turn to end.
    readonly pending: boolean;
}

export interface ModelRefusal {
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
}

type Fields = Record<string, unknown>;

export function parseModelSettings(value: unknown): ModelSettings | undefined {
    if (!isRecord(value)) return undefined;
    const model = str(value.model);
    if (model === undefined) return undefined;
    const provider = str(value.provider);
    const effort = str(value.reasoningEffort);
    const requestedEffort = str(value.requestedReasoningEffort);
    const contextWindow = num(value.contextWindow);
    const subagentDefault = parseSubagent(value.subagentDefault);
    const reviewerDefault = parseReviewer(value.reviewerDefault);
    const providers = parseProviders(value.providerCatalogs);
    return {
        ...(provider === undefined ? {} : { provider }),
        model,
        ...(effort === undefined ? {} : { effort }),
        ...(requestedEffort === undefined || requestedEffort === effort ? {} : { requestedEffort }),
        efforts: strings(value.availableReasoningEfforts),
        shortlist: entries(value.pooled, true),
        catalog: entries(value.availableModels, false),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(subagentDefault === undefined ? {} : { subagentDefault }),
        ...(reviewerDefault === undefined ? {} : { reviewerDefault }),
        ...(providers === undefined ? {} : { providers }),
    };
}

export function parseModelSettingsReply(value: Fields): ModelSettingsReply | undefined {
    const requestId = str(value.requestId);
    const settings = parseModelSettings(value.settings);
    if (requestId === undefined || settings === undefined) return undefined;
    return { requestId, settings, pending: value.pending === true };
}

// The session answers a model or effort change before the host adds the catalog: that answer lists no
// models and a bare entry for the current one, and the full reply follows. Taking it as is would hide
// the effort pill for a frame, so a reply with an empty catalog keeps the lists already shown.
export function mergeModelSettingsReply(previous: ModelSettingsReply | undefined, reply: ModelSettingsReply): ModelSettingsReply {
    if (previous === undefined || reply.settings.catalog.length > 0 || previous.settings.catalog.length === 0) return reply;
    return {
        ...reply,
        settings: { ...reply.settings, shortlist: previous.settings.shortlist, catalog: previous.settings.catalog },
    };
}

export function parseModelRefusal(value: Fields): ModelRefusal | undefined {
    const requestId = str(value.requestId);
    if (requestId === undefined) return undefined;
    return { requestId, reason: value.reason === "invalid" ? "invalid" : "unavailable" };
}

function entries(value: unknown, pooled: boolean): readonly ModelEntry[] {
    if (!Array.isArray(value)) return [];
    const parsed: ModelEntry[] = [];
    for (const raw of value) {
        const entry = parseEntry(raw, pooled);
        if (entry !== undefined) parsed.push(entry);
    }
    return parsed;
}

function parseEntry(raw: unknown, pooled: boolean): ModelEntry | undefined {
    if (!isRecord(raw)) return undefined;
    const provider = str(raw.provider);
    const model = str(raw.model);
    if (provider === undefined || model === undefined) return undefined;
    const named = pooled ? str(raw.displayName) : undefined;
    const label = named ?? str(raw.label) ?? model;
    const shortLabel = named === undefined ? withoutVendor(label) : undefined;
    const maker = shortLabel === undefined ? undefined : label.slice(0, label.length - shortLabel.length).replace(/:\s+$/, "");
    const description = str(raw.description);
    const contextWindow = num(raw.contextWindow);
    const pricing = parsePricing(raw.pricing);
    const waScore = num(raw.waScore);
    const verificationError = str(raw.verificationError);
    const defaultLevel = str(raw.defaultLevel);
    return {
        provider,
        model,
        label,
        ...(shortLabel === undefined ? {} : { shortLabel }),
        ...(maker === undefined ? {} : { maker }),
        ...(description === undefined ? {} : { description }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(pricing === undefined ? {} : { pricing }),
        ...(waScore === undefined ? {} : { waScore }),
        onPareto: raw.onPareto === true,
        ...(typeof raw.imageSupport === "boolean" ? { imageSupport: raw.imageSupport } : {}),
        verified: raw.verified === true,
        ...(verificationError === undefined ? {} : { verificationError }),
        hidden: !pooled && str(raw.hiddenByDefault) !== undefined,
        recommended: raw.recommended === true,
        levels: levels(raw.levels),
        ...(defaultLevel === undefined ? {} : { defaultLevel }),
        available: pooled ? raw.available !== false : true,
    };
}

function parsePricing(value: unknown): Pricing | undefined {
    if (!isRecord(value)) return undefined;
    const input = num(value.input);
    const output = num(value.output);
    if (input === undefined || output === undefined) return undefined;
    const cache = num(value.cache);
    return { input, output, ...(cache === undefined ? {} : { cache }) };
}

function levels(value: unknown): readonly EffortLevel[] {
    if (!Array.isArray(value)) return [];
    const parsed: EffortLevel[] = [];
    for (const raw of value) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (id === undefined) continue;
        const description = str(raw.description);
        parsed.push({ id, label: str(raw.label) ?? id, ...(description === undefined ? {} : { description }) });
    }
    return parsed;
}

function parseChoice(value: unknown): ModelChoice | undefined {
    if (!isRecord(value)) return undefined;
    const model = str(value.model);
    if (model === undefined) return undefined;
    const provider = str(value.provider);
    const effort = str(value.reasoningEffort);
    return {
        ...(provider === undefined ? {} : { provider }),
        model,
        ...(effort === undefined ? {} : { effort }),
    };
}

function parseSubagent(value: unknown): SubagentDefault | undefined {
    if (!isRecord(value)) return undefined;
    const mode = value.mode;
    if (mode !== "inherit" && mode !== "fixed" && mode !== "none") return undefined;
    const choice = parseChoice(value);
    return { mode, ...(choice === undefined ? {} : { choice }) };
}

function parseReviewer(value: unknown): ReviewerDefault | undefined {
    if (!isRecord(value)) return undefined;
    const mode = value.mode;
    if (mode !== "agent" && mode !== "fixed") return undefined;
    const primary = parseChoice(value.primary);
    const fallback = parseChoice(value.fallback);
    return {
        mode,
        ...(primary === undefined ? {} : { primary }),
        ...(fallback === undefined ? {} : { fallback }),
    };
}

function parseProviders(value: unknown): readonly ProviderCatalog[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const parsed: ProviderCatalog[] = [];
    for (const raw of value) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        const label = str(raw.label);
        if (id === undefined || label === undefined) continue;
        const refreshedAt = str(raw.refreshedAt);
        parsed.push({ id, label, ...(refreshedAt === undefined ? {} : { refreshedAt }) });
    }
    return parsed;
}

function strings(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

const VENDOR_PREFIX = /^[A-Za-z0-9][\w .&'-]{0,30}:\s+(?=\S)/;

function withoutVendor(label: string): string | undefined {
    const short = label.replace(VENDOR_PREFIX, "");
    return short === label ? undefined : short;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
