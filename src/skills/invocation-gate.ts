import type { SkillMetadata } from "./package.ts";

/**
 * Refuses a disable-model-invocation skill unless this exact top-level turn
 * came from its trusted slash command. A parent description can read exactly
 * like a human request, so neither prompt wording nor subagent input can carry
 * this boundary.
 */
export function invocationRefusal(
    metadata: SkillMetadata,
    isSubagent: boolean,
    userInvokedSkill?: string,
): string | undefined {
    if (!metadata.disableModelInvocation) {
        return undefined;
    }
    if (isSubagent) {
        return `Skill ${metadata.name} is disable-model-invocation: a subagent `
            + "cannot read or run it, regardless of how it was asked.";
    }
    if (userInvokedSkill === metadata.name) {
        return undefined;
    }
    return `Skill ${metadata.name} is disable-model-invocation: invoke `
        + `/${metadata.name} explicitly to read or run it.`;
}
