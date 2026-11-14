// The reasons mirror the host's session_move_rejected response.
export type SessionMoveReason = "invalid" | "busy" | "not_found" | "collision" | "failed";

export type MoveSessionOutcome =
    | { readonly status: "moved"; readonly workspace: string }
    | { readonly status: "cancelled" }
    | { readonly status: "rejected"; readonly reason: SessionMoveReason };
