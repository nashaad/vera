
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
    readonly fileDescriptor?: string;
    readonly operator: BashRedirectOperator;
    readonly target?: string;
}

export interface BashCommand {
    readonly kind: "command";
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

export interface BashUnknown {
    readonly kind: "unknown";
    readonly text: string;
}

export type BashStatement = BashCommand | BashPipeline | BashChain | BashUnknown;

export interface ParsedBashScript {
    readonly statements: readonly BashStatement[];
    readonly commands: readonly BashCommand[];
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

/** Loads the wasm grammar and constructs a ready `Parser`. Safe to call concurrently or repeatedly; the underlying work only happens once. */
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
            continue;
        }
        const word = literalWord(child);
        if (word === undefined) {
            hasNonLiteralWords = true;
            continue;
        }
        if (word.length > 0) {
            words.push(word);
        }
    }
    return { kind: "command", words, redirects: [], hasNonLiteralWords };
}

function literalWord(node: SyntaxNode): string | undefined {
    if (node.type === "word" || node.type === "number") {
        return node.text;
    }
    if (node.type === "raw_string") {
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

function convertRedirectedStatement(node: SyntaxNode): BashStatement {
    const body = node.childForFieldName("body");
    const base = body === null
        ? { kind: "unknown" as const, text: node.text }
        : convertStatement(body);
    const redirects = fieldChildrenOf(node, "redirect").map(convertRedirect);
    return attachRedirects(base, redirects)
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
