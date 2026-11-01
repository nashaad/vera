import { permissionModeNoWiderThan } from "../engine/permissions.ts";
import type { AgentSnapshot } from "./snapshot.ts";

// The mode to run in under an agent, never wider than `current` and always one of
// `modes`. A posture narrower than `current` applies. Otherwise `current` stays
// unless the definition forbids it, and then the first of `modes` it allows.
// Undefined if none.
export function accessModeUnderAgent(
    snapshot: Pick<AgentSnapshot, "posture" | "forbiddenAccess"> | undefined,
    current: string,
    modes: readonly string[],
): string | undefined {
    const forbidden = snapshot?.forbiddenAccess ?? [];
    const posture = snapshot?.posture;
    const allowed = (mode: string): boolean =>
        modes.includes(mode)
        && !forbidden.includes(mode)
        && permissionModeNoWiderThan(mode, current);
    if (posture !== undefined && allowed(posture)) return posture;
    if (!forbidden.includes(current)) return current;
    return modes.find(allowed);
}
