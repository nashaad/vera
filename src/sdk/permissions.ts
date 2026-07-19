export type ApprovalMode = "ask" | "approve_for_me" | "full_access";

export function isApprovalMode(value: unknown): value is ApprovalMode {
    return value === "ask"
        || value === "approve_for_me"
        || value === "full_access";
}
