import type { SandboxInspection } from "../sdk/sandbox.ts";

/**
 * One line for `/permissions`, shared so the terminal and the desktop cannot
 * describe the same state differently.
 */
export function sandboxInspectionLine(
    inspection: SandboxInspection | undefined,
    approvalMode: string,
): string {
    if (inspection === undefined || !inspection.enabled) return "Sandbox: off";
    if (approvalMode === "full_access") {
        return "Sandbox: on, not applied in full_access";
    }
    if (inspection.status === "unavailable") {
        return `Sandbox: unavailable (${inspection.reason ?? "unknown reason"}), commands run unsandboxed`;
    }
    if (inspection.network === "allowlist") {
        return `Sandbox: on, network allowlist (${inspection.allowedDomains.length} hosts)`;
    }
    return "Sandbox: on, network open";
}
