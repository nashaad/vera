import type { SkillMetadata } from "./package.ts";

/**
 * Refuses a disable-model-invocation skill for a subagent, unconditionally.
 * `isSubagent` is set once when the runtime is built, not derived from
 * anything a prompt says: a parent's spawn description can read exactly like
 * a human's request, so prompt wording cannot carry this boundary. A
 * top-level session (`isSubagent` false) is never refused here — the
 * catalog's invoke-only marker is the only gate it gets, since Vera has no
 * separate command surface to tell a human's literal ask apart from the
 * model's own judgment there.
 */
export function invocationRefusal(
    metadata: SkillMetadata,
    isSubagent: boolean,
): string | undefined {
    if (!metadata.disableModelInvocation || !isSubagent) {
        return undefined;
    }
    return `Skill ${metadata.name} is disable-model-invocation: a subagent `
        + "cannot read or run it, regardless of how it was asked.";
}
