import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    isSkillDisabled,
    rememberSkillSettings,
    resolveSkillSources,
} from "../../src/skills/sources.ts";

test("skill patterns match exact names or a trailing-star prefix", () => {
    expect(isSkillDisabled("review", ["review"])).toBe(true);
    expect(isSkillDisabled("review-deep", ["review"])).toBe(false);
    expect(isSkillDisabled("data-plot", ["data-*"])).toBe(true);
    expect(isSkillDisabled("vera-help", ["*"])).toBe(true);
    expect(isSkillDisabled("vera-help", [])).toBe(false);
});

function writeSkillExtension(directory: string, id: string): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "extension.ts"), "export default {};\n");
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: [],
        contributes: { skills: ["skills"] },
    }));
}

test("a home extension contributes its skill directories and a project one does not", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vera-skill-home-")));
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "vera-skill-project-")));
    const homeExtension = join(home, "extensions", "kernel");
    writeSkillExtension(homeExtension, "acme.kernel");
    writeFileSync(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
    }));
    writeSkillExtension(join(projectRoot, ".vera", "extensions", "cloned"), "acme.cloned");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        const sources = resolveSkillSources();

        expect(sources.extensionRoots).toContainEqual({
            extensionId: "acme.kernel",
            path: join(homeExtension, "skills"),
        });
        expect(sources.extensionRoots.map((root) => root.extensionId))
            .not.toContain("acme.cloned");
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
    }
});

function withHome<T>(home: string, run: () => T): T {
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        return run();
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
    }
}

test("a broken home config keeps the skill settings that last loaded", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vera-skill-home-")));
    const homeExtension = join(home, "extensions", "kernel");
    writeSkillExtension(homeExtension, "acme.kernel");
    const configPath = join(home, "config.json");
    writeFileSync(configPath, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
        disabled_skills: ["plunder"],
        extensions: [{ path: homeExtension }],
    }));

    withHome(home, () => {
        expect(resolveSkillSources().disabledSkills).toEqual(["plunder"]);

        writeFileSync(configPath, "{ not json");
        const kept = resolveSkillSources();

        expect(kept.disabledSkills).toEqual(["plunder"]);
        expect(kept.extensionRoots).toContainEqual({
            extensionId: "acme.kernel",
            path: join(homeExtension, "skills"),
        });
        expect(kept.warnings).toHaveLength(1);
        expect(kept.warnings[0]).toStartWith("config.json could not be read: it is not valid JSON (");
        expect(kept.warnings[0]).toEndWith(". Skills use the last settings that loaded.");
    });
});

test("a home config broken before it ever loaded turns every skill off", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vera-skill-home-")));
    writeFileSync(join(home, "config.json"), "{ not json");

    withHome(home, () => {
        const sources = resolveSkillSources();

        expect(sources.disabledSkills).toEqual(["*"]);
        expect(sources.warnings).toHaveLength(1);
        expect(sources.warnings[0]).toEndWith(". Skills are off until it loads.");
    });
});

test("a home config that was absent and then breaks keeps every skill on", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vera-skill-home-")));

    withHome(home, () => {
        rememberSkillSettings();
        writeFileSync(join(home, "config.json"), "{ not json");
        const sources = resolveSkillSources();

        expect(sources.disabledSkills).toEqual([]);
        expect(sources.warnings[0]).toEndWith(". Skills use the last settings that loaded.");
    });
});
