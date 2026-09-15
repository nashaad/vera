import type { SubagentPoolPolicy } from "./subagent.ts";

export function subagentAssignmentPolicy(
    policy: SubagentPoolPolicy | undefined,
    assignment: string | undefined,
): SubagentPoolPolicy | undefined {
    if (assignment === undefined) return policy;
    return {
        ...policy,
        assigned: policy?.assignments?.[assignment] ?? [],
        allowSelf: false,
    };
}
