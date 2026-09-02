import { connectHost, isExpectedHostClose } from "./connection.ts";
import type { CatalogRefreshOutcome } from "./protocol.ts";

const CATALOG_REFRESH_TIMEOUT_MS = 30_000;

const CATALOG_REFRESH_FAILURES = new Set<string>([
    "authentication",
    "unavailable",
    "malformed_response",
    "empty_response",
    "missing_credential",
    "persistence_failed",
    "invalid",
]);

export class CatalogRefreshUnsupportedError extends Error {
    constructor() {
        super("Resident host does not refresh catalogs");
        this.name = "CatalogRefreshUnsupportedError";
    }
}

export function isCatalogRefreshFallback(error: unknown): boolean {
    return error instanceof CatalogRefreshUnsupportedError
        || isExpectedHostClose(error)
        || (
            error instanceof Error
            && error.name === "HostConnectionClosedError"
        );
}

export async function refreshCatalogsThroughHost(
    socketPath: string,
    responseTimeoutMs = CATALOG_REFRESH_TIMEOUT_MS,
): Promise<readonly CatalogRefreshOutcome[]> {
    const connection = await connectHost({ socketPath });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({ type: "refresh_catalogs" });
        const response = asRecord(await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Host catalog refresh deadline exceeded"));
                }, responseTimeoutMs);
            }),
        ]));
        if (response?.type === "protocol_error") {
            throw new CatalogRefreshUnsupportedError();
        }
        if (
            response?.type === "refresh_catalogs_failed"
            && typeof response.reason === "string"
        ) {
            throw new Error(response.reason);
        }
        const outcomes = parseOutcomes(response?.outcomes);
        if (response?.type !== "refresh_catalogs_result" || outcomes === undefined) {
            throw new CatalogRefreshUnsupportedError();
        }
        return outcomes;
    } finally {
        clearTimeout(timeout);
        connection.close();
    }
}

function parseOutcomes(
    value: unknown,
): readonly CatalogRefreshOutcome[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const outcomes: CatalogRefreshOutcome[] = [];
    for (const entry of value) {
        const outcome = parseOutcome(entry);
        if (outcome === undefined) return undefined;
        outcomes.push(outcome);
    }
    return outcomes;
}

function parseOutcome(value: unknown): CatalogRefreshOutcome | undefined {
    const record = asRecord(value);
    if (record === undefined || typeof record.provider !== "string"
        || record.provider.length === 0)
    {
        return undefined;
    }
    const models = record.models;
    if (
        models !== undefined
        && (!Number.isSafeInteger(models) || (models as number) < 0)
    ) {
        return undefined;
    }
    const keptModels = record.keptModels;
    if (
        keptModels !== undefined
        && (!Number.isSafeInteger(keptModels) || (keptModels as number) < 0)
    ) {
        return undefined;
    }
    const failure = record.failure;
    if (
        failure !== undefined
        && (typeof failure !== "string" || !CATALOG_REFRESH_FAILURES.has(failure))
    ) {
        return undefined;
    }
    return {
        provider: record.provider,
        ...(models === undefined ? {} : { models: models as number }),
        ...(failure === undefined
            ? {}
            : { failure: failure as CatalogRefreshOutcome["failure"] }),
        ...(keptModels === undefined ? {} : { keptModels: keptModels as number }),
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
