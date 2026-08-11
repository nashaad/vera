import { expect, test } from "bun:test";

import { renderSkillCatalog } from "../../src/skills/contribution.ts";
import type { SkillCatalog } from "../../src/skills/catalog.ts";

test("the catalog exposes metadata and paths without loading instructions", () => {
    const content = renderSkillCatalog(catalog([
        skill("consult", "Compare two independent answers."),
    ]));

    expect(content).toContain("consult: Compare two independent answers.");
    expect(content).toContain("/skills/consult/SKILL.md");
    expect(content).toContain("read that skill's SKILL.md");
    expect(content).not.toContain("SECRET BODY");
});

test("a large catalog is bounded and reports omitted skills", () => {
    const skills = Array.from({ length: 200 }, (_, index) =>
        skill(`skill-${index}`, "x".repeat(100))
    );
    const content = renderSkillCatalog(catalog(skills));

    expect(content.length).toBeLessThanOrEqual(8_100);
    expect(content).toContain("additional skill(s) omitted");
});

function catalog(skills: SkillCatalog["skills"]): SkillCatalog {
    return { skills, warnings: [] };
}

function skill(name: string, description: string): SkillCatalog["skills"][number] {
    return {
        directory: `/skills/${name}`,
        skillPath: `/skills/${name}/SKILL.md`,
        scope: "user",
        metadata: { name, description, extra: {} },
        instructions: "SECRET BODY",
    };
}
