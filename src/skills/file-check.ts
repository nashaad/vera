import {
    findDisabledSkillByPath,
    findSkillByPath,
    loadSkillCatalog,
} from "./catalog.ts";
import { invocationRefusal } from "./invocation-gate.ts";
import type { SkillFileCheck } from "../tools/runtime.ts";

// Why a read of this SKILL.md is refused, or undefined when it may be read.
export async function skillFileRefusal(
    check: SkillFileCheck,
): Promise<string | undefined> {
    const catalog = await loadSkillCatalog({ projectRoot: check.projectRoot });
    const disabled = findDisabledSkillByPath(catalog, check.path);
    if (disabled !== undefined) {
        return `Skill ${disabled.metadata.name} is disabled by disabled_skills.`;
    }
    const skill = findSkillByPath(catalog, check.path);
    if (skill === undefined) {
        return undefined;
    }
    if (
        check.allowedSkills !== undefined
        && !check.allowedSkills.includes(skill.metadata.name)
    ) {
        return `Skill ${skill.metadata.name} is not available to the active agent.`;
    }
    return invocationRefusal(
        skill.metadata,
        check.isSubagent,
        check.userInvokedSkill,
    );
}
