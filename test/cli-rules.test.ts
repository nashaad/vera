import { expect, test } from "bun:test";

import { renderRulesFor, runRulesCli } from "../clients/cli/rules.ts";
import type { Rule, RuleSnapshot } from "../src/engine/rules.ts";

const WORKSPACE = "/work/vera";

function rule(overrides: Partial<Rule> & Pick<Rule, "displayPath">): Rule {
    return {
        scope: "project",
        path: `${WORKSPACE}/.vera/rules/x.md`,
        paths: [],
        body: "body",
        ...overrides,
    };
}

const SNAPSHOT: RuleSnapshot = {
    rules: [
        rule({ scope: "user", displayPath: "<home>/rules/tone.md" }),
        rule({ displayPath: ".vera/rules/engine.md", paths: ["src/engine/**"] }),
        rule({ displayPath: ".vera/rules/tui.md", paths: ["clients/tui/**"] }),
    ],
    warnings: [],
};

function collector(): { text: string; write(text: string): void } {
    return {
        text: "",
        write(text: string) {
            this.text += text;
        },
    };
}

test("which names the glob that pulls each rule in", () => {
    expect(renderRulesFor(SNAPSHOT.rules, "src/engine/run-turn.ts")).toBe(
        "Rules for src/engine/run-turn.ts:\n"
            + "  always         <home>/rules/tone.md\n"
            + "  src/engine/**  .vera/rules/engine.md\n",
    );
});

test("which still lists the always-on rules when no glob matches", () => {
    expect(renderRulesFor(SNAPSHOT.rules, "README.md")).toBe(
        "Rules for README.md:\n  always  <home>/rules/tone.md\n",
    );
});

test("no rules at all says so rather than printing an empty table", () => {
    expect(renderRulesFor([], "README.md")).toBe(
        "No rules apply to README.md.\n",
    );
});

test("a path outside the workspace is refused", async () => {
    const output = collector();
    const errorOutput = collector();
    const code = await runRulesCli(
        ["which", "/etc/hosts"],
        WORKSPACE,
        output,
        errorOutput,
        async () => SNAPSHOT,
    );
    expect(code).toBe(1);
    expect(errorOutput.text).toContain("outside /work/vera");
    expect(output.text).toBe("");
});

test("a bad subcommand prints the usage line", async () => {
    const output = collector();
    const errorOutput = collector();
    expect(
        await runRulesCli(["list"], WORKSPACE, output, errorOutput, async () => SNAPSHOT),
    ).toBe(1);
    expect(errorOutput.text).toBe("vera rules: usage: vera rules which <path>\n");
});

test("loading warnings go to stderr and do not stop the answer", async () => {
    const output = collector();
    const errorOutput = collector();
    const code = await runRulesCli(
        ["which", "src/engine/run-turn.ts"],
        WORKSPACE,
        output,
        errorOutput,
        async () => ({
            rules: SNAPSHOT.rules,
            warnings: [{ scope: "project", message: ".vera/rules/bad.md was skipped" }],
        }),
    );
    expect(code).toBe(0);
    expect(errorOutput.text).toBe("vera rules: .vera/rules/bad.md was skipped\n");
    expect(output.text).toContain(".vera/rules/engine.md");
});
