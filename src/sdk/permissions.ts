export type BuiltInPermissionModeName =
    | "readonly"
    | "ask"
    | "auto"
    | "full_access";
export type ApprovalMode = string;

export function isApprovalMode(value: unknown): value is ApprovalMode {
    return typeof value === "string"
        && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

export function parseApprovalMode(value: unknown): ApprovalMode | undefined {
    if (value === "approve_for_me") {
        return "auto";
    }
    if (isApprovalMode(value)) {
        return value;
    }
    return undefined;
}
