import { addDefaultParsers } from "@opentui/core";

interface TuiParserSource {
    readonly filetype: string;
    readonly wasm: string;
    readonly highlights: readonly string[];
    readonly aliases?: readonly string[];
}

const NVIM = "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries";

/** Extra parsers registered through OpenTUI's Tree-sitter integration. Its JavaScript, TypeScript, Markdown, and Zig parsers remain built in; OpenTUI fetches and caches these. */
export const TUI_PARSER_SOURCES: readonly TuiParserSource[] = [
    parser("python", "tree-sitter/tree-sitter-python", "v0.23.6", "tree-sitter-python.wasm",
        ["https://github.com/tree-sitter/tree-sitter-python/raw/refs/heads/master/queries/highlights.scm"]),
    parser("rust", "tree-sitter/tree-sitter-rust", "v0.24.0", "tree-sitter-rust.wasm",
        [`${NVIM}/rust/highlights.scm`]),
    parser("go", "tree-sitter/tree-sitter-go", "v0.25.0", "tree-sitter-go.wasm",
        [`${NVIM}/go/highlights.scm`]),
    parser("cpp", "tree-sitter/tree-sitter-cpp", "v0.23.4", "tree-sitter-cpp.wasm",
        [`${NVIM}/cpp/highlights.scm`]),
    parser("csharp", "tree-sitter/tree-sitter-c-sharp", "v0.23.1", "tree-sitter-c_sharp.wasm",
        [`${NVIM}/c_sharp/highlights.scm`]),
    parser("bash", "tree-sitter/tree-sitter-bash", "v0.25.0", "tree-sitter-bash.wasm",
        [`${NVIM}/bash/highlights.scm`]),
    parser("c", "tree-sitter/tree-sitter-c", "v0.24.1", "tree-sitter-c.wasm",
        [`${NVIM}/c/highlights.scm`]),
    parser("java", "tree-sitter/tree-sitter-java", "v0.23.5", "tree-sitter-java.wasm",
        [`${NVIM}/java/highlights.scm`]),
    parser("kotlin", "fwcd/tree-sitter-kotlin", "0.3.8", "tree-sitter-kotlin.wasm",
        ["https://raw.githubusercontent.com/fwcd/tree-sitter-kotlin/0.3.8/queries/highlights.scm"]),
    parser("ruby", "tree-sitter/tree-sitter-ruby", "v0.23.1", "tree-sitter-ruby.wasm",
        [`${NVIM}/ruby/highlights.scm`]),
    parser("php", "tree-sitter/tree-sitter-php", "v0.24.2", "tree-sitter-php.wasm",
        ["https://github.com/tree-sitter/tree-sitter-php/raw/refs/heads/master/queries/highlights.scm"]),
    parser("scala", "tree-sitter/tree-sitter-scala", "v0.24.0", "tree-sitter-scala.wasm",
        [`${NVIM}/scala/highlights.scm`]),
    parser("html", "tree-sitter/tree-sitter-html", "v0.23.2", "tree-sitter-html.wasm",
        ["https://github.com/tree-sitter/tree-sitter-html/raw/refs/heads/master/queries/highlights.scm"]),
    parser("vue", "anomalyco/tree-sitter-vue", "v0.1.2", "tree-sitter-vue.wasm", [
        "https://raw.githubusercontent.com/anomalyco/tree-sitter-vue/v0.1.2/queries/html_tags/highlights.scm",
        "https://raw.githubusercontent.com/anomalyco/tree-sitter-vue/v0.1.2/queries/vue/highlights.scm",
    ]),
    parser("hcl", "tree-sitter-grammars/tree-sitter-hcl", "v1.2.0", "tree-sitter-hcl.wasm",
        [`${NVIM}/hcl/highlights.scm`]),
    parser("json", "tree-sitter/tree-sitter-json", "v0.24.8", "tree-sitter-json.wasm",
        [`${NVIM}/json/highlights.scm`]),
    parser("yaml", "tree-sitter-grammars/tree-sitter-yaml", "v0.7.2", "tree-sitter-yaml.wasm",
        [`${NVIM}/yaml/highlights.scm`]),
    parser("haskell", "tree-sitter/tree-sitter-haskell", "v0.23.1", "tree-sitter-haskell.wasm",
        [`${NVIM}/haskell/highlights.scm`]),
    parser("css", "tree-sitter/tree-sitter-css", "v0.25.0", "tree-sitter-css.wasm",
        [`${NVIM}/css/highlights.scm`]),
    parser("julia", "tree-sitter/tree-sitter-julia", "v0.23.1", "tree-sitter-julia.wasm",
        [`${NVIM}/julia/highlights.scm`]),
    parser("lua", "tree-sitter-grammars/tree-sitter-lua", "v0.5.0", "tree-sitter-lua.wasm",
        ["https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-lua/v0.5.0/queries/highlights.scm"]),
    parser("ocaml", "tree-sitter/tree-sitter-ocaml", "v0.24.2", "tree-sitter-ocaml.wasm",
        [`${NVIM}/ocaml/highlights.scm`]),
    parser("clojure", "anomalyco/tree-sitter-clojure", "v0.0.1", "tree-sitter-clojure.wasm",
        [`${NVIM}/clojure/highlights.scm`]),
    parser("swift", "alex-pinkus/tree-sitter-swift", "0.7.1", "tree-sitter-swift.wasm",
        ["https://raw.githubusercontent.com/alex-pinkus/tree-sitter-swift/main/queries/highlights.scm"]),
    parser("toml", "tree-sitter-grammars/tree-sitter-toml", "v0.7.0", "tree-sitter-toml.wasm",
        [`${NVIM}/toml/highlights.scm`]),
    {
        filetype: "nix",
        wasm: "https://github.com/ast-grep/ast-grep.github.io/raw/40b84530640aa83a0d34a20a2b0623d7b8e5ea97/website/public/parsers/tree-sitter-nix.wasm",
        highlights: [`${NVIM}/nix/highlights.scm`],
    },
    parser("diff", "tree-sitter-grammars/tree-sitter-diff", "v0.1.0", "tree-sitter-diff.wasm",
        ["https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-diff/master/queries/highlights.scm"],
        ["udiff", "patch"]),
    parser("elixir", "elixir-lang/tree-sitter-elixir", "v0.3.5", "tree-sitter-elixir.wasm",
        [`${NVIM}/elixir/highlights.scm`]),
    parser("fsharp", "ionide/tree-sitter-fsharp", "0.3.0", "tree-sitter-fsharp.wasm",
        [`${NVIM}/fsharp/highlights.scm`]),
    parser("r", "r-lib/tree-sitter-r", "v1.2.0", "tree-sitter-r.wasm",
        [`${NVIM}/r/highlights.scm`]),
    parser("make", "tree-sitter-grammars/tree-sitter-make", "v1.1.1", "tree-sitter-make.wasm",
        [`${NVIM}/make/highlights.scm`], ["makefile"]),
    parser("vim", "tree-sitter-grammars/tree-sitter-vim", "v0.8.1", "tree-sitter-vim.wasm",
        [`${NVIM}/vim/highlights.scm`]),
    parser("xml", "tree-sitter-grammars/tree-sitter-xml", "v0.7.0", "tree-sitter-xml.wasm",
        [`${NVIM}/xml/highlights.scm`]),
    parser("agda", "tree-sitter/tree-sitter-agda", "v1.3.3", "tree-sitter-agda.wasm",
        [`${NVIM}/agda/highlights.scm`]),
];

export function registerTuiParsers(
    register: typeof addDefaultParsers = addDefaultParsers,
): void {
    register(TUI_PARSER_SOURCES.map((source) => ({
        filetype: source.filetype,
        aliases: source.aliases === undefined ? undefined : [...source.aliases],
        wasm: source.wasm,
        queries: { highlights: [...source.highlights] },
    })));
}

function parser(
    filetype: string,
    repository: string,
    version: string,
    wasm: string,
    highlights: readonly string[],
    aliases?: readonly string[],
): TuiParserSource {
    return {
        filetype,
        wasm: `https://github.com/${repository}/releases/download/${version}/${wasm}`,
        highlights,
        aliases,
    };
}
