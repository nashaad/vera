import type { LanguageFn } from "highlight.js";

type LanguageModule = { readonly default: LanguageFn };

export interface LanguageEntry {
    readonly name: string;
    readonly aliases: readonly string[];
    // Languages the grammar embeds; they must be registered before it runs.
    readonly needs: readonly string[];
    readonly load: () => Promise<LanguageModule>;
}

function entry(
    name: string,
    aliases: readonly string[],
    load: () => Promise<LanguageModule>,
    needs: readonly string[] = [],
): LanguageEntry {
    return { name, aliases, needs, load };
}

// Each import is its own chunk, fetched the first time a block in that language is highlighted.
const ENTRIES: readonly LanguageEntry[] = [
    entry("bash", ["sh", "zsh", "shell", "shellscript"], () => import("highlight.js/lib/languages/bash")),
    entry("c", ["h"], () => import("highlight.js/lib/languages/c")),
    entry("cpp", ["cc", "c++", "h++", "hpp", "hh", "hxx", "cxx"], () => import("highlight.js/lib/languages/cpp")),
    entry("csharp", ["cs", "c#"], () => import("highlight.js/lib/languages/csharp")),
    entry("css", [], () => import("highlight.js/lib/languages/css")),
    entry("diff", ["patch"], () => import("highlight.js/lib/languages/diff")),
    entry("dockerfile", ["docker"], () => import("highlight.js/lib/languages/dockerfile"), ["bash"]),
    entry("elixir", ["ex", "exs"], () => import("highlight.js/lib/languages/elixir")),
    entry("go", ["golang"], () => import("highlight.js/lib/languages/go")),
    entry("graphql", ["gql"], () => import("highlight.js/lib/languages/graphql")),
    entry("haskell", ["hs"], () => import("highlight.js/lib/languages/haskell")),
    entry("ini", ["toml"], () => import("highlight.js/lib/languages/ini")),
    entry("java", ["jsp"], () => import("highlight.js/lib/languages/java")),
    entry(
        "javascript",
        ["js", "jsx", "mjs", "cjs"],
        () => import("highlight.js/lib/languages/javascript"),
        ["xml", "css", "graphql"],
    ),
    entry("json", ["jsonc", "json5"], () => import("highlight.js/lib/languages/json")),
    entry("kotlin", ["kt", "kts"], () => import("highlight.js/lib/languages/kotlin")),
    entry("less", [], () => import("highlight.js/lib/languages/less")),
    entry("lua", [], () => import("highlight.js/lib/languages/lua")),
    entry("makefile", ["mk", "mak", "make"], () => import("highlight.js/lib/languages/makefile")),
    entry("markdown", ["md", "mkd"], () => import("highlight.js/lib/languages/markdown"), ["xml"]),
    entry("nginx", ["nginxconf"], () => import("highlight.js/lib/languages/nginx")),
    entry("objectivec", ["objc", "obj-c", "mm"], () => import("highlight.js/lib/languages/objectivec")),
    entry("perl", ["pl", "pm"], () => import("highlight.js/lib/languages/perl")),
    entry("php", [], () => import("highlight.js/lib/languages/php")),
    entry("powershell", ["pwsh", "ps", "ps1"], () => import("highlight.js/lib/languages/powershell")),
    entry("protobuf", ["proto"], () => import("highlight.js/lib/languages/protobuf")),
    entry("python", ["py", "gyp", "ipython"], () => import("highlight.js/lib/languages/python")),
    entry("r", [], () => import("highlight.js/lib/languages/r")),
    entry("ruby", ["rb", "gemspec", "podspec", "thor", "irb"], () => import("highlight.js/lib/languages/ruby")),
    entry("rust", ["rs"], () => import("highlight.js/lib/languages/rust")),
    entry("scala", [], () => import("highlight.js/lib/languages/scala")),
    entry("scss", [], () => import("highlight.js/lib/languages/scss")),
    entry("shell-session", ["console", "shellsession"], () => import("highlight.js/lib/languages/shell"), ["bash"]),
    entry("sql", [], () => import("highlight.js/lib/languages/sql")),
    entry("swift", [], () => import("highlight.js/lib/languages/swift")),
    entry(
        "typescript",
        ["ts", "tsx", "mts", "cts"],
        () => import("highlight.js/lib/languages/typescript"),
        ["xml", "css", "graphql"],
    ),
    entry("xml", ["html", "xhtml", "rss", "atom", "xsd", "xsl", "plist", "svg"], () => import("highlight.js/lib/languages/xml"), ["css", "javascript"]),
    entry("yaml", ["yml"], () => import("highlight.js/lib/languages/yaml")),
];

const BY_NAME = new Map<string, LanguageEntry>();
for (const language of ENTRIES) {
    BY_NAME.set(language.name, language);
    for (const alias of language.aliases) BY_NAME.set(alias, language);
}

// The info string after the opening fence: "ts", "TypeScript", "ts title=a.ts" and "language-ts" all name TypeScript.
export function languageFor(info: string): LanguageEntry | undefined {
    const word = info.trim().split(/[\s{]/, 1)[0] ?? "";
    const name = word.toLowerCase().replace(/^language-/, "");
    return name === "" ? undefined : BY_NAME.get(name);
}

export function languageNamed(name: string): LanguageEntry {
    const found = BY_NAME.get(name);
    if (found === undefined) throw new Error(`No highlight grammar named ${name}`);
    return found;
}
