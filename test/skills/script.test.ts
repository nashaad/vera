import { expect, test } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRuntime } from "../../src/tools/runtime.ts";
import {
    isDeclaredScript,
    runSkillScript,
    skillScriptTool,
} from "../../src/skills/script.ts";
import { projectSkillDirectory } from "../../src/skills/catalog.ts";
import { SKILL_FILENAME } from "../../src/skills/package.ts";

test("only safe scripts explicitly referenced by the skill are declared", () => {
    const instructions = "Run `scripts/check.sh` or ./scripts/fix.py when needed.";

    expect(isDeclaredScript("scripts/check.sh", instructions)).toBe(true);
    expect(isDeclaredScript("scripts/fix.py", instructions)).toBe(true);
    expect(isDeclaredScript("scripts/check", instructions)).toBe(false);
    expect(isDeclaredScript("../scripts/check.sh", instructions)).toBe(false);
    expect(isDeclaredScript("scripts/../SKILL.md", instructions)).toBe(false);
    expect(isDeclaredScript("/tmp/check.sh", instructions)).toBe(false);
});

test("skill_script runs declared argv in the workspace with a bounded environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skill-run-"));
    const workspace = join(root, "workspace");
    const skillDirectory = join(projectSkillDirectory(workspace), "inspect");
    const scriptsDirectory = join(skillDirectory, "scripts");
    mkdirSync(scriptsDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, SKILL_FILENAME), `---
name: inspect
description: Inspect argv and environment.
---
Run \`scripts/inspect.sh\`.
`);
    const scriptPath = join(scriptsDirectory, "inspect.sh");
    writeFileSync(scriptPath, `#!/bin/sh
printf 'cwd=%s\\narg=%s\\nskill=%s\\nsecret=%s\\n' "$PWD" "$1" "$VERA_SKILL_DIR" "$SKILL_TEST_SECRET"
`);
    chmodSync(scriptPath, 0o755);
    process.env.SKILL_TEST_SECRET = "must-not-leak";
    try {
        const result = await skillScriptTool.execute({
            skill: "inspect",
            script: "scripts/inspect.sh",
            args: ["hello world"],
        }, new ToolRuntime(workspace), new AbortController().signal);

        expect(result.kind).toBe("output");
        if (result.kind !== "output") return;
        expect(result.isError).toBe(false);
        expect(result.output).toContain(`cwd=${realpathSync(workspace)}`);
        expect(result.output).toContain("arg=hello world");
        expect(result.output).toContain(`skill=${realpathSync(skillDirectory)}`);
        expect(result.output).toContain("secret=");
        expect(result.output).not.toContain("must-not-leak");
    } finally {
        delete process.env.SKILL_TEST_SECRET;
    }
});

test("skill_script requires a trusted top-level turn for invoke-only skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skill-gate-"));
    const workspace = join(root, "workspace");
    const skillDirectory = join(projectSkillDirectory(workspace), "adversarial");
    const scriptsDirectory = join(skillDirectory, "scripts");
    mkdirSync(scriptsDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, SKILL_FILENAME), `---
name: adversarial
description: Read-only adversarial review.
disable-model-invocation: true
---
Run \`scripts/review.sh\`.
`);
    const scriptPath = join(scriptsDirectory, "review.sh");
    writeFileSync(scriptPath, "#!/bin/sh\necho ok\n");
    chmodSync(scriptPath, 0o755);

    const subagentRuntime = new ToolRuntime(
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
    );
    await expect(skillScriptTool.execute({
        skill: "adversarial",
        script: "scripts/review.sh",
    }, subagentRuntime, new AbortController().signal))
        .resolves.toEqual({
            kind: "output",
            output:
                "The skill_script tool is available only to top-level sessions.",
            isError: true,
        });

    const topLevelRuntime = new ToolRuntime(workspace);
    await expect(skillScriptTool.execute({
        skill: "adversarial",
        script: "scripts/review.sh",
    }, topLevelRuntime, new AbortController().signal)).rejects.toThrow(
        "invoke /adversarial explicitly",
    );

    topLevelRuntime.userInvokedSkill = "adversarial";
    const result = await skillScriptTool.execute({
        skill: "adversarial",
        script: "scripts/review.sh",
    }, topLevelRuntime, new AbortController().signal);
    expect(result.kind).toBe("output");
    if (result.kind === "output") {
        expect(result.isError).toBe(false);
        expect(result.output).toContain("ok");
    }
});

test("skill scripts time out with a terminal error", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skill-timeout-"));
    const scriptPath = join(root, "slow.sh");
    writeFileSync(scriptPath, "#!/bin/sh\nsleep 5\n");
    chmodSync(scriptPath, 0o755);

    const result = await runSkillScript({
        scriptPath,
        args: [],
        workspace: root,
        skillDirectory: root,
        timeoutMs: 20,
        signal: new AbortController().signal,
    });

    expect(result).toEqual({
        kind: "output",
        output: "Skill script timed out after 20 ms",
        isError: true,
    });
});

test("a silent nonzero exit reports its code", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skill-exit-"));
    const scriptPath = join(root, "fail.sh");
    writeFileSync(scriptPath, "#!/bin/sh\nexit 7\n");
    chmodSync(scriptPath, 0o755);

    const result = await runSkillScript({
        scriptPath,
        args: [],
        workspace: root,
        skillDirectory: root,
        timeoutMs: 1_000,
        signal: new AbortController().signal,
    });

    expect(result).toEqual({
        kind: "output",
        output: "Skill script exited with code 7",
        isError: true,
    });
});

test("skill_script refuses an instruction that did not declare the script", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skill-refuse-"));
    const skillDirectory = join(projectSkillDirectory(root), "inspect");
    mkdirSync(join(skillDirectory, "scripts"), { recursive: true });
    writeFileSync(join(skillDirectory, SKILL_FILENAME), `---
name: inspect
description: Inspect the workspace.
---
Do the inspection.
`);

    expect(skillScriptTool.execute({
        skill: "inspect",
        script: "scripts/inspect.sh",
    }, new ToolRuntime(root), new AbortController().signal)).rejects.toThrow(
        "does not reference script",
    );
});
