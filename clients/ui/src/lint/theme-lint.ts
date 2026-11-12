import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { ALL_TOKENS } from "../theme/tokens.ts";

export interface ThemeViolation {
    readonly file: string;
    readonly line: number;
    readonly rule: string;
    readonly text: string;
}

const SCAN_ROOTS = ["clients/ui/src", "clients/desktop/src", "clients/desktop/index.html"];

// The lint's own patterns are literals by design.
const SKIP_DIRECTORIES = ["clients/ui/src/lint"];

const TEXT_EXTENSIONS = [".ts", ".tsx", ".css", ".html"];

interface Rule {
    readonly rule: string;
    readonly pattern: RegExp;
    // Named colors are ordinary words in code, so they are only read in stylesheets.
    readonly stylesheetOnly?: boolean;
}

const COLOR_NAMES = "red|blue|green|black|white|gray|grey|orange|yellow|purple|pink|brown|cyan|magenta|navy|teal|silver|gold|lime|maroon|olive|aqua|fuchsia|indigo|violet|crimson|coral|salmon|tomato|ivory|beige|khaki|lavender|orchid|plum|tan|turquoise";
const LENGTH_UNITS = "px|rem|em|pt|pc|ch|vh|vw|vmin|vmax|cm|mm";
const CSS_PROPERTY_START = "(?<![-\\w])";

const RULES: readonly Rule[] = [
    { rule: "color", pattern: /#[0-9a-fA-F]{3,8}\b/g },
    { rule: "color", pattern: /(?<![-\w])(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch)\(/g },
    {
        rule: "color",
        pattern: new RegExp(`:\\s*[^;{}]*?(?<![-\\w#.])(?:${COLOR_NAMES})(?![-\\w])`, "g"),
        stylesheetOnly: true,
    },
    {
        rule: "color",
        pattern: /\b(?:fill|stroke|stopColor|floodColor|lightingColor)=["'](?!none\b|currentColor\b|url\()/g,
    },
    { rule: "size", pattern: new RegExp(`(?<![\\w.])(?:\\d*\\.)?\\d+(?:${LENGTH_UNITS})\\b`, "g") },
    {
        rule: "font",
        pattern: new RegExp(`${CSS_PROPERTY_START}font-family\\s*:\\s*(?!\\s)(?!inherit\\b|var\\()`, "g"),
    },
    {
        rule: "font",
        pattern: new RegExp(`${CSS_PROPERTY_START}font\\s*:\\s*(?!\\s)(?!inherit\\b|var\\()`, "g"),
        stylesheetOnly: true,
    },
    {
        rule: "shadow",
        pattern: new RegExp(`${CSS_PROPERTY_START}(?:box|text)-shadow\\s*:\\s*(?!\\s)(?!none\\b|inherit\\b|var\\()`, "g"),
    },
    {
        rule: "duration",
        pattern: new RegExp(
            `${CSS_PROPERTY_START}(?:transition|animation)(?:-duration|-delay)?\\s*:[^;{}]*?(?<![\\w.-])(?:\\d*\\.)?\\d+m?s\\b`,
            "g",
        ),
    },
    { rule: "inline-style", pattern: /\.style\.\w+\s*=\s*[`"']/g },
    { rule: "inline-style", pattern: /\.style\.cssText\b/g },
    { rule: "inline-style", pattern: /setAttribute\(\s*["']style["']/g },
];

const STYLE_BLOCK = /(?:style=\{\{|\bCSSProperties\b[^=\n;]*=\s*\{)([\s\S]*?)\}\}?/g;
const STYLE_STRING_COLOR = /(?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke)\s*:\s*["'`](?!var\(|currentColor|none|inherit|transparent)[^"'`]+["'`]/;
const STYLE_SIZE_PROPERTIES = "width|height|minWidth|maxWidth|minHeight|maxHeight|padding|paddingTop|paddingRight|paddingBottom|paddingLeft|margin|marginTop|marginRight|marginBottom|marginLeft|gap|fontSize|lineHeight|top|left|right|bottom|borderRadius|borderWidth|flexBasis";
const STYLE_STRING_UNIT = new RegExp(`(?:${STYLE_SIZE_PROPERTIES})\\s*:\\s*["'\`][^"'\`]*\\d+(?:\\.\\d+)?(?:${LENGTH_UNITS}|%)[^"'\`]*["'\`]`);
const STYLE_NUMBER_SIZE = new RegExp(`(?:${STYLE_SIZE_PROPERTIES})\\s*:\\s*\\d`);
const STYLE_FONT = /fontFamily\s*:\s*["'`](?!var\(|inherit)[^"'`]+["'`]/;
const STYLE_SHADOW = /boxShadow\s*:\s*["'`](?!var\(|none|inherit)[^"'`]+["'`]/;
const STYLE_DURATION = /(?:transition|animation)\w*\s*:\s*["'`][^"'`]*\d+(?:\.\d+)?m?s[^"'`]*["'`]/;

const TOKEN_REFERENCE = /--vera-([a-z0-9-]+)/g;

export function themeViolations(
    root: string,
    scanRoots: readonly string[] = SCAN_ROOTS,
): readonly ThemeViolation[] {
    const knownTokens = new Set<string>(ALL_TOKENS);
    const violations: ThemeViolation[] = [];
    for (const scanRoot of scanRoots) {
        for (const file of filesUnder(resolve(root, scanRoot))) {
            const relativePath = relative(root, file).split(sep).join("/");
            if (SKIP_DIRECTORIES.some((skip) => relativePath === skip || relativePath.startsWith(`${skip}/`))) {
                continue;
            }
            checkFile(file, relativePath, knownTokens, violations);
        }
    }
    return violations;
}

function filesUnder(path: string): readonly string[] {
    let stat;
    try {
        stat = statSync(path);
    } catch {
        return [];
    }
    if (stat.isFile()) return isTextFile(path) ? [path] : [];
    const files: string[] = [];
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) files.push(...filesUnder(join(path, entry.name)));
        else if (entry.isFile() && isTextFile(entry.name)) files.push(join(path, entry.name));
    }
    return files;
}

function isTextFile(path: string): boolean {
    return TEXT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function checkFile(
    path: string,
    relativePath: string,
    knownTokens: ReadonlySet<string>,
    violations: ThemeViolation[],
): void {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const stylesheet = path.endsWith(".css") || path.endsWith(".html");
    const lineOf = (index: number): number => text.slice(0, index).split("\n").length;
    const add = (rule: string, index: number): void => {
        const line = lineOf(index);
        violations.push({ file: relativePath, line, rule, text: (lines[line - 1] ?? "").trim() });
    };
    for (const { rule, pattern, stylesheetOnly } of RULES) {
        if (stylesheetOnly === true && !stylesheet) continue;
        for (const match of text.matchAll(pattern)) add(rule, match.index);
    }
    for (const match of text.matchAll(TOKEN_REFERENCE)) {
        if (!knownTokens.has(match[1]!)) add("unknown-token", match.index);
    }
    for (const style of text.matchAll(STYLE_BLOCK)) {
        const body = style[1] ?? "";
        const rule = STYLE_STRING_COLOR.test(body) ? "color"
            : STYLE_STRING_UNIT.test(body) || STYLE_NUMBER_SIZE.test(body) ? "size"
            : STYLE_FONT.test(body) ? "font"
            : STYLE_SHADOW.test(body) ? "shadow"
            : STYLE_DURATION.test(body) ? "duration"
            : undefined;
        if (rule !== undefined) add(rule, style.index);
    }
}
