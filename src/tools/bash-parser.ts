/**
 * A real bash parser (tree-sitter-bash via web-tree-sitter), used to build a
 * structured view of a command's redirects, pipes, chains, and
 * substitutions, in place of the hand-written tokenizer in
 * `bash-danger.ts`.
 *
 * tree-sitter init is async and the classifier (`decideToolPermission`) is
 * synchronous, so `initBashParser()` must be awaited once before
 * `parseBashScript` can be called. `runTurn` does that await, which keeps
 * the ordering inside the engine instead of asking every client to
 * remember it at boot. Until it resolves, `extractBashActions` reports
 * `unknown` for every bash command rather than guessing.
 *
 * Anything this parser does not specifically model (subshells, `if`/`for`/
 * `case`/`while`, heredocs, and anything the grammar itself cannot parse)
 * becomes a `BashUnknown` node carrying its raw source text, rather than a
 * guess — mirroring the "unknown action" fallback the rest of the
 * permission engine already uses.
 */

import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

export type BashRedirectOperator =
    | ">"
    | ">>"
    | "<"
    | "<<"
    | "<<<"
    | ">&"
    | "<&"
    | "&>"
    | "&>>"
    | "unknown";

export interface BashRedirect {
    /** e.g. `2` in `2>&1`. Absent when the redirect has no explicit fd. */
    readonly fileDescriptor?: string;
    readonly operator: BashRedirectOperator;
    /**
     * The literal redirect target text (e.g. `a.txt`, `&1`, `/dev/null`).
     * Absent when the target is not a plain word (contains an expansion or
     * substitution the caller would need to resolve separately).
     */
    readonly target?: string;
}

export interface BashCommand {
    readonly kind: "command";
    /**
     * Literal words only (the command name and any plain-word arguments).
     * A non-literal argument (variable expansion, command/process
     * substitution, quoted string with expansion, etc.) is omitted here and
     * reflected in `hasNonLiteralWords` instead of being guessed at.
     */
    readonly words: readonly string[];
    readonly redirects: readonly BashRedirect[];
    readonly hasNonLiteralWords: boolean;
}

export interface BashPipeline {
    readonly kind: "pipeline";
    readonly stages: readonly BashStatement[];
}

export type BashChainOperator = "&&" | "||" | ";" | "&";

export interface BashChain {
    readonly kind: "chain";
    readonly operator: BashChainOperator;
    readonly left: BashStatement;
    readonly right: BashStatement;
}

/** Something the parser recognized structurally but does not model further. */
export interface BashUnknown {
    readonly kind: "unknown";
    readonly text: string;
}

export type BashStatement = BashCommand | BashPipeline | BashChain | BashUnknown;

export interface ParsedBashScript {
    /** Top-level statements, in source order. */
    readonly statements: readonly BashStatement[];
    /** Every simple command found anywhere in the tree, flattened, in order. */
    readonly commands: readonly BashCommand[];
    /**
     * Raw source text found inside every `$(...)`, `` `...` ``, or `<(...)`/
     * `>(...)` in the script, for recursive re-parsing — the tree-sitter
     * analogue of `nestedShellCommands` in `bash-danger.ts`.
     */
    readonly substitutions: readonly string[];
}

const REDIRECT_OPERATORS = new Set<string>([
    ">",
    ">>",
    "<",
    "<<",
    "<<<",
    ">&",
    "<&",
    "&>",
    "&>>",
]);

const CHAIN_OPERATORS = new Set<string>(["&&", "||", ";", "&"]);

let parserPromise: Promise<Parser> | undefined;
let resolvedParser: Parser | undefined;

/**
 * Loads the wasm grammar and constructs a ready `Parser`. Safe to call
 * concurrently or repeatedly; the underlying work only happens once.
 */
export async function initBashParser(): Promise<void> {
    if (parserPromise === undefined) {
        parserPromise = createBashParser();
    }
    resolvedParser = await parserPromise;
}

export function isBashParserReady(): boolean {
    return resolvedParser !== undefined;
}

async function createBashParser(): Promise<Parser> {
    await Parser.init();
    const packageUrl = import.meta.resolve("tree-sitter-bash/package.json");
    const wasmUrl = new URL("./tree-sitter-bash.wasm", packageUrl);
    const bytes = new Uint8Array(await Bun.file(wasmUrl).arrayBuffer());
    const language = await Language.load(bytes);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}

/**
 * Parses a bash source string into a structured script. Requires
 * `initBashParser()` to have already resolved — kept synchronous so a
 * future caller can use it from a synchronous classification path without
 * making that path async.
 */
export function parseBashScript(source: string): ParsedBashScript {
    if (resolvedParser === undefined) {
        throw new Error(
            "parseBashScript called before initBashParser() resolved",
        );
    }
    const tree = resolvedParser.parse(source);
    const root = tree?.rootNode;
    if (root === undefined || root === null) {
        return { statements: [], commands: [], substitutions: [] };
    }

    const statements = namedChildrenOf(root).map(convertStatement);
    const commands: BashCommand[] = [];
    for (const statement of statements) {
        collectCommands(statement, commands);
    }
    const substitutions = collectSubstitutions(root);

    return { statements, commands, substitutions };
}

/**
 * `web-tree-sitter` types the child arrays as `(Node | null)[]`, because the
 * underlying C API returns null for an index with no node. The arrays are
 * dense in practice, so the null is discharged once in these three helpers
 * rather than guarded at every walk site below.
 */
function namedChildrenOf(node: SyntaxNode): SyntaxNode[] {
    return node.namedChildren.filter(isNode);
}

function childrenOf(node: SyntaxNode): SyntaxNode[] {
    return node.children.filter(isNode);
}

function fieldChildrenOf(node: SyntaxNode, field: string): SyntaxNode[] {
    return node.childrenForFieldName(field).filter(isNode);
}

function isNode(value: SyntaxNode | null): value is SyntaxNode {
    return value !== null;
}

function convertStatement(node: SyntaxNode): BashStatement {
    switch (node.type) {
        case "command":
            return convertCommand(node);
        case "redirected_statement":
            return convertRedirectedStatement(node);
        case "pipeline":
            return convertPipeline(node);
        case "list":
            return convertChain(node);
        default:
            return { kind: "unknown", text: node.text };
    }
}

function convertCommand(node: SyntaxNode): BashCommand {
    const words: string[] = [];
    let hasNonLiteralWords = false;
    for (const child of namedChildrenOf(node)) {
        if (child.type === "command_name") {
            const nameWord = child.namedChild(0);
            const name = nameWord === null ? undefined : literalWord(nameWord);
            if (name === undefined) {
                hasNonLiteralWords = true;
            } else {
                words.push(name);
            }
            continue;
        }
        if (child.type === "variable_assignment") {
            // Environment assignments prefixing the command (`FOO=1 cmd`)
            // are neither the command name nor an argument; skip them
            // rather than misclassifying them as either.
            continue;
        }
        const word = literalWord(child);
        if (word === undefined) {
            hasNonLiteralWords = true;
            continue;
        }
        // An empty quoted word (`rm ""`) contributes no argument. Dropping it
        // keeps a caller from resolving "" against the working directory and
        // treating the directory itself as the target.
        if (word.length > 0) {
            words.push(word);
        }
    }
    return { kind: "command", words, redirects: [], hasNonLiteralWords };
}

/**
 * The literal text of a word, or `undefined` when the word is not literal.
 *
 * Quoting is not the same as expansion: `rm 'my notes.md'` and `rm "my notes.md"`
 * name one concrete file, while `rm "$DIR"` names whatever the shell decides at
 * run time. Only the second is genuinely unknowable here, so quotes are removed
 * and the content returned, and a word containing any expansion or substitution
 * (including a concatenation with one) returns `undefined`.
 */
function literalWord(node: SyntaxNode): string | undefined {
    if (node.type === "word" || node.type === "number") {
        return node.text;
    }
    if (node.type === "raw_string") {
        // Single quotes suppress every expansion, so the content is always
        // literal. The node text carries the quotes; strip exactly one pair.
        return node.text.slice(1, -1);
    }
    if (node.type !== "string") {
        return undefined;
    }
    let text = "";
    for (const child of namedChildrenOf(node)) {
        if (child.type !== "string_content") {
            return undefined;
        }
        text += child.text;
    }
    return text;
}

/**
 * The grammar hangs the redirect off the whole body, so `cd /tmp && ls > out.txt`
 * arrives as one `redirected_statement` wrapping the entire list, and
 * `foo | bar > out.txt` as one wrapping the entire pipeline. Bash binds the
 * redirect to the last simple command in both cases, so that is where it goes.
 *
 * Returning `unknown` for the whole construct instead, as this used to, discarded
 * every command inside it along with the redirect: `cd /tmp && rm -rf x > log`
 * produced no `rm` at all.
 */
function convertRedirectedStatement(node: SyntaxNode): BashStatement {
    const body = node.childForFieldName("body");
    const base = body === null
        ? { kind: "unknown" as const, text: node.text }
        : convertStatement(body);
    const redirects = fieldChildrenOf(node, "redirect").map(convertRedirect);
    return attachRedirects(base, redirects)
        // A body with no simple command to own the redirect (a brace group, an
        // `if`, anything the grammar models but this module does not) stays
        // unknown, rather than the redirect being reassigned to some other
        // statement or silently dropped.
        ?? { kind: "unknown", text: node.text };
}

function attachRedirects(
    statement: BashStatement,
    redirects: readonly BashRedirect[],
): BashStatement | undefined {
    if (statement.kind === "command") {
        return { ...statement, redirects: [...statement.redirects, ...redirects] };
    }
    if (statement.kind === "pipeline") {
        const stages = replaceLast(statement.stages, redirects);
        return stages === undefined ? undefined : { ...statement, stages };
    }
    if (statement.kind === "chain") {
        const right = attachRedirects(statement.right, redirects);
        return right === undefined ? undefined : { ...statement, right };
    }
    return undefined;
}

function replaceLast(
    stages: readonly BashStatement[],
    redirects: readonly BashRedirect[],
): BashStatement[] | undefined {
    const last = stages.at(-1);
    if (last === undefined) {
        return undefined;
    }
    const replacement = attachRedirects(last, redirects);
    return replacement === undefined
        ? undefined
        : [...stages.slice(0, -1), replacement];
}

function convertRedirect(node: SyntaxNode): BashRedirect {
    const descriptor = node.childForFieldName("descriptor");
    const destination = node.childForFieldName("destination");
    const operatorNode = childrenOf(node).find((child) =>
        !child.isNamed && REDIRECT_OPERATORS.has(child.type)
    );
    const operator = (operatorNode?.type ?? "unknown") as BashRedirectOperator;
    // A quoted target (`> "my notes.txt"`) is as literal as a bare word, so it
    // goes through the same literal-word reader the arguments use.
    const target = destination === null ? undefined : literalWord(destination);
    return {
        ...(descriptor === null ? {} : { fileDescriptor: descriptor.text }),
        operator,
        ...(target === undefined ? {} : { target }),
    };
}

function convertPipeline(node: SyntaxNode): BashPipeline {
    return {
        kind: "pipeline",
        stages: namedChildrenOf(node).map(convertStatement),
    };
}

function convertChain(node: SyntaxNode): BashStatement {
    const [left, right] = namedChildrenOf(node);
    const operatorNode = childrenOf(node).find((child) =>
        !child.isNamed && CHAIN_OPERATORS.has(child.type)
    );
    if (left === undefined || right === undefined || operatorNode === undefined) {
        return { kind: "unknown", text: node.text };
    }
    return {
        kind: "chain",
        operator: operatorNode.type as BashChainOperator,
        left: convertStatement(left),
        right: convertStatement(right),
    };
}

function collectCommands(statement: BashStatement, into: BashCommand[]): void {
    if (statement.kind === "command") {
        into.push(statement);
        return;
    }
    if (statement.kind === "pipeline") {
        for (const stage of statement.stages) {
            collectCommands(stage, into);
        }
        return;
    }
    if (statement.kind === "chain") {
        collectCommands(statement.left, into);
        collectCommands(statement.right, into);
    }
    // `unknown`: nothing to flatten.
}

function collectSubstitutions(root: SyntaxNode): string[] {
    const substitutions: string[] = [];
    walk(root, (node) => {
        if (
            node.type === "command_substitution"
            || node.type === "process_substitution"
        ) {
            const inner = node.namedChild(0);
            if (inner !== null) {
                substitutions.push(inner.text);
            }
        }
    });
    return substitutions;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
    visit(node);
    for (const child of namedChildrenOf(node)) {
        walk(child, visit);
    }
}
