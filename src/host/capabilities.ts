const MAX_HOST_CAPABILITIES = 64;
const HOST_CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[1-9][0-9]*$/;

export const HOST_CAPABILITY_AGENT_BRANCH_OPTIONS = "agent.branch-options.v1";
export const HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES =
    "agent.branch-initial-messages.v1";
export const HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS =
    "agent.branch-compaction-barriers.v1";
export const HOST_CAPABILITY_AGENT_ATTACH_RESUME = "agent.attach-resume.v1";
export const HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE =
    "agent.attachment-release.v1";
export const HOST_CAPABILITY_AGENT_CONTEXT_SYNC = "agent.context-sync.v1";
export const HOST_CAPABILITY_HARNESS_MESSAGES = "harness-messages.v1";
export const HOST_CAPABILITY_PROMPT_QUEUE_RELEASE = "prompt-queue.release.v1";
export const HOST_CAPABILITY_SESSION_SCOPED_STATE = "session-scoped-state.v1";
export const HOST_CAPABILITY_SKILL_COMMANDS = "skills.commands.v1";
export const HOST_CAPABILITY_WORK_INDEX = "work.index.v1";
export const HOST_CAPABILITY_ANNEX = "annex.v1";
export const HOST_CAPABILITY_HOME_SNAPSHOT = "home.snapshot.v1";

export const HOST_CAPABILITIES = [
    HOST_CAPABILITY_AGENT_BRANCH_OPTIONS,
    HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES,
    HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS,
    HOST_CAPABILITY_AGENT_ATTACH_RESUME,
    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
    HOST_CAPABILITY_AGENT_CONTEXT_SYNC,
    HOST_CAPABILITY_HARNESS_MESSAGES,
    HOST_CAPABILITY_PROMPT_QUEUE_RELEASE,
    HOST_CAPABILITY_SESSION_SCOPED_STATE,
    HOST_CAPABILITY_SKILL_COMMANDS,
    HOST_CAPABILITY_WORK_INDEX,
    HOST_CAPABILITY_ANNEX,
    HOST_CAPABILITY_HOME_SNAPSHOT,
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
