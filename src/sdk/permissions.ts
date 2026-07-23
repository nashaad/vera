export type ApprovalMode = "ask" | "auto" | "full_access";

export function isApprovalMode(value: unknown): value is ApprovalMode {
    return value === "ask"
        || value === "auto"
        || value === "full_access";
}

export function parseApprovalMode(value: unknown): ApprovalMode | undefined {
    if (isApprovalMode(value)) {
        return value;
    }
    return value === "approve_for_me" ? "auto" : undefined;
}
