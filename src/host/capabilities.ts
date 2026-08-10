const MAX_HOST_CAPABILITIES = 64;
const HOST_CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[1-9][0-9]*$/;

export const HOST_CAPABILITY_AGENT_BRANCH_OPTIONS = "agent.branch-options.v1";
export const HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES =
    "agent.branch-initial-messages.v1";
export const HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS =
    "agent.branch-compaction-barriers.v1";

export const HOST_CAPABILITIES = [
    HOST_CAPABILITY_AGENT_BRANCH_OPTIONS,
    HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES,
    HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS,
] as const;

export function parseHostCapabilities(
    value: unknown,
): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_HOST_CAPABILITIES) {
        return undefined;
    }
    const capabilities: string[] = [];
    const seen = new Set<string>();
    for (const capability of value) {
        if (
            typeof capability !== "string"
            || !HOST_CAPABILITY_NAME.test(capability)
            || seen.has(capability)
        ) {
            return undefined;
        }
        seen.add(capability);
        capabilities.push(capability);
    }
    return capabilities;
}

export function negotiateHostCapabilities(
    requested: readonly string[],
    supported: readonly string[],
): readonly string[] {
    const supportedSet = new Set(supported);
    return requested.filter((capability) => supportedSet.has(capability));
}
