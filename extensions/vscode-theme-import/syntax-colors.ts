import { SYNTAX_TOKENS, type SyntaxToken } from "../../clients/ui/src/theme/tokens.ts";
import { parseColor } from "./vscode-color.ts";

// Scope names a token of each kind carries in a TextMate grammar. A rule for the scope or any prefix of it
// colors the token, so the first probe a theme styles at all names the theme's color for that kind.
const PROBES: Readonly<Record<SyntaxToken, readonly string[]>> = {
    "syntax-comment": ["comment.line", "comment.block"],
    "syntax-keyword": ["keyword.control.conditional", "storage.type.function", "keyword.operator.new"],
    "syntax-string": ["string.quoted.double", "string.template"],
    "syntax-number": ["constant.numeric.decimal", "constant.language.boolean"],
    "syntax-function": ["entity.name.function", "support.function"],
    "syntax-type": ["entity.name.type.class", "support.class", "entity.name.type", "support.type"],
    "syntax-property": ["variable.other.property", "support.type.property-name", "meta.object-literal.key", "entity.other.attribute-name"],
    "syntax-tag": ["entity.name.tag", "meta.tag"],
};

interface ScopeRule {
    readonly scope: string;
    readonly color: string;
}

// Rules in file order. A rule with no scope sets the editor default, and a selector with spaces, which names a
// parent scope or excludes one, is not read.
function scopeRules(tokenColors: readonly unknown[]): ScopeRule[] {
    const rules: ScopeRule[] = [];
    for (const entry of tokenColors) {
        if (typeof entry !== "object" || entry === null) continue;
        const { scope, settings } = entry as { scope?: unknown; settings?: unknown };
        const color = typeof settings === "object" && settings !== null
            ? parseColor((settings as { foreground?: unknown }).foreground)
            : undefined;
        if (color === undefined) continue;
        const names = Array.isArray(scope) ? scope : [scope];
        for (const name of names.flatMap((value) => (typeof value === "string" ? value.split(",") : []))) {
            const trimmed = name.trim();
            if (trimmed.length > 0 && !/\s/.test(trimmed)) rules.push({ scope: trimmed, color });
        }
    }
    return rules;
}

function depth(scope: string): number {
    return scope.split(".").length;
}

// The deepest rule whose scope is the probe or a prefix of it; of equal depth, the one written last.
function colorFor(rules: readonly ScopeRule[], probe: string): string | undefined {
    let best: ScopeRule | undefined;
    for (const rule of rules) {
        if (probe !== rule.scope && !probe.startsWith(`${rule.scope}.`)) continue;
        if (best === undefined || depth(rule.scope) >= depth(best.scope)) best = rule;
    }
    return best?.color;
}

// The colors a VS Code theme's token rules give each kind of code token. A kind the theme does not style is left out.
export function syntaxColors(tokenColors: readonly unknown[]): Partial<Record<SyntaxToken, string>> {
    const rules = scopeRules(tokenColors);
    const found: Partial<Record<SyntaxToken, string>> = {};
    if (rules.length === 0) return found;
    for (const token of SYNTAX_TOKENS) {
        for (const probe of PROBES[token]) {
            const color = colorFor(rules, probe);
            if (color === undefined) continue;
            found[token] = color;
            break;
        }
    }
    return found;
}
