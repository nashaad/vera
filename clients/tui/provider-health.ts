
import type { VeraConfig } from "../../src/config.ts";
import { loadOptionalVeraConfig } from "../../src/config.ts";
import { admitModel } from "../../src/model/admission.ts";
import { effectiveCatalog } from "../../src/model/catalog.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import { oauthToken, type AuthStorage } from "../../src/providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "../../src/providers/openai-codex-oauth.ts";
import {
    configuredProviders,
    findConfiguredProvider,
    isProviderConnected,
} from "../../src/providers/registry.ts";
import { tuiKeyChord, tuiKeyHint } from "./keymap.ts";

export type ProviderHealthTone = "green" | "yellow" | "red";

export interface HealthRung {
    readonly provider: string;
    readonly model: string;
}

export interface HealthRungResult {
    readonly rung: HealthRung;
    readonly answered: boolean;
}

export type ProviderHealthStatus =
    | { readonly kind: "idle" }
    | {
        readonly kind: "checking";
        readonly current: number;
        readonly total: number;
        readonly label: string;
    }
    | {
        readonly kind: "ready";
        readonly tone: ProviderHealthTone;
        readonly summary: string;
        readonly next?: string;
        readonly details?: readonly string[];
    };

export function idleProviderHealth(): ProviderHealthStatus {
    return { kind: "idle" };
}

export function rungLabel(rung: HealthRung): string {
    return `${rung.provider}/${rung.model}`;
}

export function healthRungsOf(
    settings: ModelTurnSettings | undefined,
    config: Pick<VeraConfig, "provider" | "model" | "providers"> | undefined =
        loadOptionalVeraConfig(),
): readonly HealthRung[] {
    const pooled = settings?.pooled ?? [];
    if (pooled.length > 0) {
        return pooled.map((entry) => ({
            provider: entry.provider,
            model: entry.model,
        }));
    }
    if (
        settings?.provider !== undefined
        && settings.model.length > 0
        && isProbeableProvider(settings.provider, config)
    ) {
        return [{ provider: settings.provider, model: settings.model }];
    }
    if (
        config !== undefined
        && config.model.length > 0
        && isProbeableProvider(config.provider, config)
    ) {
        return [{ provider: config.provider, model: config.model }];
    }
    return [];
}

export function hasConfiguredProvider(
    authStorage: Pick<AuthStorage, "getCredential">,
    config: Pick<VeraConfig, "providers" | "provider_endpoints"> | undefined =
        loadOptionalVeraConfig(),
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    if (
        config?.providers !== undefined
        && Object.keys(config.providers).length > 0
    ) {
        return true;
    }
    for (const provider of configuredProviders(config)) {
        try {
            if (isProviderConnected(provider, { authStorage, env })) {
                return true;
            }
        } catch {
        }
    }
    return false;
}

export function expiredOAuthProvider(
    storage: Pick<AuthStorage, "getCredential">,
    now = Date.now(),
): string | undefined {
    const token = oauthToken(storage, OPENAI_CODEX_PROVIDER_ID);
    if (token === undefined) return undefined;
    try {
        const parsed: unknown = JSON.parse(token);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const record = parsed as Record<string, unknown>;
        const expiresAt = typeof record.expires_at === "number"
            ? record.expires_at
            : typeof record.expires === "number"
            ? record.expires
            : undefined;
        if (expiresAt !== undefined && expiresAt <= now) {
            return OPENAI_CODEX_PROVIDER_ID;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

export function summarizeProviderHealth(options: {
    readonly results: readonly HealthRungResult[];
    readonly configured: boolean;
    readonly expiredCredential?: string;
}): Extract<ProviderHealthStatus, { kind: "ready" }> {
    const { results, configured } = options;
    if (results.length === 0 && !configured) {
        return {
            kind: "ready",
            tone: "red",
            summary: "no provider configured",
            next: "/models then Providers to connect one",
        };
    }
    if (results.length === 0) {
        return {
            kind: "ready",
            tone: "red",
            summary: "no model in your favorites",
            next: "/model to add one",
        };
    }
    const answered = results.filter((result) => result.answered);
    if (answered.length === 0) {
        return {
            kind: "ready",
            tone: "red",
            summary: "nothing answered",
            next: "/models then Providers to connect one",
        };
    }
    const first = answered[0]!;
    const firstIndex = results.findIndex((result) => result.answered);
    const hasFallback = firstIndex >= 0 && firstIndex < results.length - 1;
    const details = [
        ...results
            .filter((result) => !result.answered)
            .map((result) => `${rungLabel(result.rung)} failed`),
        ...(options.expiredCredential === undefined
            ? []
            : [`${options.expiredCredential} credential is expired`]),
    ];
    const extra = details.length === 0 ? {} : { details };
    if (hasFallback) {
        return {
            kind: "ready",
            tone: "green",
            summary: `${rungLabel(first.rung)} answered`,
            ...extra,
        };
    }
    const verifyHint = tuiKeyHint("verify_pool").split(" ")[0] ?? "^⇧v";
    const next = results.length === 1
        ? "/model to add a fallback"
        : `/model then Verify all (${verifyHint}) to repair the earlier rungs`;
    return {
        kind: "ready",
        tone: "yellow",
        summary: `only the last favorite answered (${rungLabel(first.rung)})`,
        next,
        ...extra,
    };
}

export function ellipsizeHealthTail(text: string, max: number): string {
    if (max <= 0) return "";
    if (text.length <= max) return text;
    if (max === 1) return "…";
    return `…${text.slice(text.length - (max - 1))}`;
}

export function renderProviderHealth(
    status: ProviderHealthStatus,
    maxWidth = 72,
): string[] {
    if (status.kind === "idle") {
        const chord = tuiKeyChord("check_provider_health") || "v";
        return [ellipsizeHealthTail(`  not checked  press ${chord}`, maxWidth)];
    }
    if (status.kind === "checking") {
        const prefix = `  checking   ${status.current} of ${status.total}  `;
        return [
            prefix + ellipsizeHealthTail(status.label, maxWidth - prefix.length),
        ];
    }
    const tonePrefix = `  ${status.tone.padEnd(8)} `;
    const lines = [
        tonePrefix
            + ellipsizeHealthTail(status.summary, maxWidth - tonePrefix.length),
    ];
    const detailPrefix = " ".repeat(tonePrefix.length);
    for (const detail of status.details ?? []) {
        lines.push(
            detailPrefix
                + ellipsizeHealthTail(detail, maxWidth - detailPrefix.length),
        );
    }
    if (status.next !== undefined) {
        const nextPrefix = "  next        ";
        lines.push(
            nextPrefix
                + ellipsizeHealthTail(status.next, maxWidth - nextPrefix.length),
        );
    }
    return lines;
}

export async function runProviderHealthCheck(options: {
    readonly rungs: readonly HealthRung[];
    readonly configured: boolean;
    readonly expiredCredential?: string;
    readonly probe: (
        rung: HealthRung,
        signal: AbortSignal,
    ) => Promise<boolean>;
    readonly signal: AbortSignal;
    readonly onProgress: (status: ProviderHealthStatus) => void;
}): Promise<ProviderHealthStatus> {
    if (options.rungs.length === 0) {
        const ready = summarizeProviderHealth({
            results: [],
            configured: options.configured,
            ...(options.expiredCredential === undefined
                ? {}
                : { expiredCredential: options.expiredCredential }),
        });
        options.onProgress(ready);
        return ready;
    }
    const results: HealthRungResult[] = [];
    for (const [index, rung] of options.rungs.entries()) {
        if (options.signal.aborted) {
            return idleProviderHealth();
        }
        options.onProgress({
            kind: "checking",
            current: index + 1,
            total: options.rungs.length,
            label: rungLabel(rung),
        });
        let answered = false;
        try {
            answered = await options.probe(rung, options.signal);
        } catch {
            answered = false;
        }
        if (options.signal.aborted) {
            return idleProviderHealth();
        }
        results.push({ rung, answered });
    }
    const ready = summarizeProviderHealth({
        results,
        configured: options.configured,
        ...(options.expiredCredential === undefined
            ? {}
            : { expiredCredential: options.expiredCredential }),
    });
    options.onProgress(ready);
    return ready;
}

export async function admitHealthRung(
    rung: HealthRung,
    options: {
        readonly authStorage?: AuthStorage;
        readonly signal?: AbortSignal;
        readonly config?: VeraConfig;
    } = {},
): Promise<boolean> {
    const config = options.config ?? loadOptionalVeraConfig();
    const adapter = createConfiguredModelAdapter(
        {
            ...(config ?? { provider: rung.provider }),
            provider: rung.provider,
        } as VeraConfig,
        options.authStorage === undefined ? {} : { authStorage: options.authStorage },
    );
    const catalogModel = effectiveCatalog(rung.provider).models.find(
        (candidate) => candidate.id === rung.model,
    );
    const verdict = await admitModel({
        adapter,
        provider: rung.provider,
        model: rung.model,
        ...(catalogModel === undefined ? {} : { catalogModel }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return verdict.status === "added";
}

function isProbeableProvider(
    provider: string,
    config: Pick<VeraConfig, "providers"> | undefined,
): boolean {
    return findConfiguredProvider(provider, config) !== undefined
        || config?.providers?.[provider] !== undefined;
}
