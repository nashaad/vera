import {
    globMatches,
    loadRules,
    ruleDirectories,
    workspaceRelativePath,
    type Rule,
    type RuleSnapshot,
} from "../../src/engine/rules.ts";

interface Output {
    write(text: string): unknown;
}

export async function runRulesCli(
    args: readonly string[],
    workspace: string,
    output: Output,
    errorOutput: Output,
    load: (workspace: string) => Promise<RuleSnapshot> = (dir) =>
        loadRules(ruleDirectories(dir)),
): Promise<number> {
    if (args[0] !== "which" || args.length !== 2) {
        errorOutput.write("vera rules: usage: vera rules which <path>\n");
        return 1;
    }
    const target = args[1]!;
    const relative = workspaceRelativePath(workspace, target);
    if (relative === undefined) {
        errorOutput.write(`vera rules: ${target} is outside ${workspace}\n`);
        return 1;
    }
    const snapshot = await load(workspace);
    for (const warning of snapshot.warnings) {
        errorOutput.write(`vera rules: ${warning.message}\n`);
    }
    output.write(renderRulesFor(snapshot.rules, relative));
    return 0;
}

export function renderRulesFor(
    rules: readonly Rule[],
    relativePath: string,
): string {
    const rows = rules
        .map((rule) => ({ rule, trigger: triggerFor(rule, relativePath) }))
        .filter((row): row is { rule: Rule; trigger: string } =>
            row.trigger !== undefined
        );
    if (rows.length === 0) {
        return `No rules apply to ${relativePath}.\n`;
    }
    const width = Math.max(...rows.map((row) => row.trigger.length));
    const lines = rows.map((row) =>
        `  ${row.trigger.padEnd(width)}  ${row.rule.displayPath}`
    );
    return `Rules for ${relativePath}:\n${lines.join("\n")}\n`;
}

/** The glob that brings the rule in, or "always" for one with no paths. */
function triggerFor(rule: Rule, relativePath: string): string | undefined {
    if (rule.paths.length === 0) {
        return "always";
    }
    return rule.paths.find((glob) => globMatches(glob, relativePath));
}
