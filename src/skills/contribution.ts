import type { PromptContribution } from "../engine/prompt-contributions.ts";
import type { InstructionRoot } from "../engine/memory.ts";
import {
    loadSkillCatalog,
    type SkillCatalog,
} from "./catalog.ts";

const MAX_CATALOG_CHARACTERS = 8_000;

export async function loadSkillContribution(
    instructionRoot: InstructionRoot,
    /**
     * The skills the worn agent may see. Absent means all of them, which is
     * what an agent that names no skill list gets.
     */
    allowedSkills?: readonly string[],
): Promise<readonly PromptContribution[]> {
    const loaded = await loadSkillCatalog({ projectRoot: instructionRoot.path });
    const catalog: SkillCatalog = allowedSkills === undefined ? loaded : {
        ...loaded,
        skills: loaded.skills.filter((skill) =>
            allowedSkills.includes(skill.metadata.name)
        ),
    };
    if (catalog.skills.length === 0 && catalog.warnings.length === 0) {
        return [];
    }
    return [{
        id: "host.skills",
        owner: "host",
        target: "contextual",
        title: "Skills",
        content: renderSkillCatalog(catalog),
    }];
}

export function renderSkillCatalog(catalog: SkillCatalog): string {
    const header = [
        "Reusable workflows available to this agent are listed below.",
        "When the user names a skill with `$name`, or the task clearly matches its description, read that skill's SKILL.md with the read tool before following it.",
        "Resolve referenced files from the skill directory. Supporting files are not separate skills. Run a referenced script only through skill_script.",
        "",
    ].join("\n");
    let content = header;
    let omitted = 0;
    for (const skill of catalog.skills) {
        const line = `- ${skill.metadata.name}: ${skill.metadata.description} (${skill.skillPath})\n`;
        if (content.length + line.length > MAX_CATALOG_CHARACTERS) {
            omitted += 1;
            continue;
        }
        content += line;
    }
    if (omitted > 0) {
        content += `- ${omitted} additional skill(s) omitted from this catalog\n`;
    }
    for (const warning of catalog.warnings) {
        const line = `- Warning: ${warning}\n`;
        if (content.length + line.length > MAX_CATALOG_CHARACTERS) {
            break;
        }
        content += line;
    }
    return content.trimEnd();
}
