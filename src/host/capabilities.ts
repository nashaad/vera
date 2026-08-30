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
/**
 * Session-scoped settings: dial a model or a posture for this session without
 * rewriting the host's defaults, read back what the session has held, and tell
 * a parent-turn fallback from a subagent's own substitution.
 *
 * One capability for the whole set on purpose. A host that has some of these
 * and not others would leave the dial strip half working, and a strip that
 * silently rewrites global defaults is worse than no strip.
 */
export const HOST_CAPABILITY_SESSION_SCOPED_STATE = "session-scoped-state.v1";
/** Trusted skill catalogs and per-turn user slash invocation. */
export const HOST_CAPABILITY_SKILL_COMMANDS = "skills.commands.v1";
/** Machine-wide work inbox: a snapshot on attach, then changes as they land. */
export const HOST_CAPABILITY_WORK_INDEX = "work.index.v1";
/** Loopback Vera web usage page served by this host. */
export const HOST_CAPABILITY_WEB_USAGE = "web.usage.v1";

export const HOST_CAPABILITIES = [
    HOST_CAPABILITY_AGENT_BRANCH_OPTIONS,
    HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES,
    HOST_CAPABILITY_AGENT_BRANCH_COMPACTION_BARRIERS,
    HOST_CAPABILITY_AGENT_ATTACH_RESUME,
    HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
    HOST_CAPABILITY_AGENT_CONTEXT_SYNC,
    HOST_CAPABILITY_HARNESS_MESSAGES,
    HOST_CAPABILITY_SESSION_SCOPED_STATE,
    HOST_CAPABILITY_SKILL_COMMANDS,
    HOST_CAPABILITY_WORK_INDEX,
    HOST_CAPABILITY_WEB_USAGE,
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
