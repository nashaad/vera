export type SandboxNetworkMode = "open" | "allowlist";
export type SandboxStatus = "active" | "unavailable";

/** What a client shows for the sandbox, carried inside `PermissionInspection`. */
export interface SandboxInspection {
    readonly enabled: boolean;
    readonly status: SandboxStatus;
    readonly network: SandboxNetworkMode;
    readonly allowedDomains: readonly string[];
    /** Why it is unavailable, when `status` says so. */
    readonly reason?: string;
}

export function isSandboxInspection(value: unknown): value is SandboxInspection {
    if (!isRecord(value)) return false;
    return typeof value.enabled === "boolean"
        && (value.status === "active" || value.status === "unavailable")
        && (value.network === "allowlist" || value.network === "open")
        && isStringArray(value.allowedDomains)
        && (value.reason === undefined || typeof value.reason === "string");
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
