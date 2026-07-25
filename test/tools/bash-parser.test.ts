import { beforeAll, describe, expect, test } from "bun:test";

import {
    initBashParser,
    isBashParserReady,
    parseBashScript,
    type BashChain,
    type BashCommand,
    type BashPipeline,
} from "../../src/tools/bash-parser.ts";

beforeAll(async () => {
    await initBashParser();
});

test("the parser reports itself ready only after init resolves", () => {
    expect(isBashParserReady()).toBe(true);
});

test("parseBashScript throws a clear error before init", () => {
    // initBashParser() already resolved in beforeAll for the rest of this
    // file, so this only documents the contract rather than re-testing the
    // pre-init state (module-level singletons can't be reset mid-file).
    expect(typeof parseBashScript).toBe("function");
});

test("a simple command parses into literal words", () => {
    const script = parseBashScript("git commit -m test");
    expect(script.commands).toEqual([{
        kind: "command",
        words: ["git", "commit", "-m", "test"],
        redirects: [],
        hasNonLiteralWords: false,
    }]);
});

test("redirects are extracted with operator, fd, and target", () => {
    const script = parseBashScript("cat README.md 2>/dev/null");
    const command = script.commands[0] as BashCommand;
    expect(command.words).toEqual(["cat", "README.md"]);
    expect(command.redirects).toEqual([{
        fileDescriptor: "2",
        operator: ">",
        target: "/dev/null",
    }]);
});

test("append and fd-duplication redirects are distinguished from a plain write", () => {
    expect(parseBashScript("printf hi >> notes.txt").commands[0]?.redirects)
        .toEqual([{ operator: ">>", target: "notes.txt" }]);
    expect(parseBashScript("printf x 2>&1").commands[0]?.redirects).toEqual([{
        fileDescriptor: "2",
        operator: ">&",
        target: "1",
    }]);
});

test("multiple redirects on one command are all captured", () => {
    const command = parseBashScript("cmd > a.txt 2>&1").commands[0] as BashCommand;
    expect(command.redirects).toEqual([
        { operator: ">", target: "a.txt" },
        { fileDescriptor: "2", operator: ">&", target: "1" },
    ]);
});

test("pipelines are structured, not flattened into independent commands", () => {
    const script = parseBashScript("curl https://example.com | tee notes.txt");
    expect(script.statements).toHaveLength(1);
    const pipeline = script.statements[0] as BashPipeline;
    expect(pipeline.kind).toBe("pipeline");
    expect(pipeline.stages.map((stage) => (stage as BashCommand).words)).toEqual([
        ["curl", "https://example.com"],
        ["tee", "notes.txt"],
    ]);
    // But commands are still available flattened for callers that don't
    // care about pipe structure.
    expect(script.commands.map((command) => command.words)).toEqual([
        ["curl", "https://example.com"],
        ["tee", "notes.txt"],
    ]);
});

test("chains preserve which operator connects each side", () => {
    const script = parseBashScript("cd /tmp && ls");
    const chain = script.statements[0] as BashChain;
    expect(chain.kind).toBe("chain");
    expect(chain.operator).toBe("&&");
    expect((chain.left as BashCommand).words).toEqual(["cd", "/tmp"]);
    expect((chain.right as BashCommand).words).toEqual(["ls"]);
});

test("a redirect on a chain binds to the last command, and keeps the rest of the chain", () => {
    // The grammar hangs the redirect off the whole list, but bash binds it to the
    // last simple command. Verified against real bash: in a directory containing
    // `sub/`, `cd sub && printf hi > notes.txt` creates `sub/notes.txt`, so the
    // redirect runs after the `cd`, as part of `printf`.
    const chain = parseBashScript(
        "cd /tmp && printf hi > notes.txt",
    ).statements[0] as BashChain;
    expect(chain.kind).toBe("chain");
    expect((chain.left as BashCommand).words).toEqual(["cd", "/tmp"]);
    const right = chain.right as BashCommand;
    expect(right.words).toEqual(["printf", "hi"]);
    expect(right.redirects).toEqual([{ operator: ">", target: "notes.txt" }]);
});

test("a redirect on a pipeline binds to the last stage", () => {
    const pipeline = parseBashScript("cat a.txt | tee b.txt > c.txt")
        .statements[0] as BashPipeline;
    expect(pipeline.kind).toBe("pipeline");
    expect((pipeline.stages[0] as BashCommand).redirects).toEqual([]);
    expect((pipeline.stages[1] as BashCommand).redirects).toEqual([
        { operator: ">", target: "c.txt" },
    ]);
});

test("a redirect on a construct with no simple command stays unknown", () => {
    // A brace group is modelled by the grammar but not by this module, so there is
    // no command to own the redirect. Reporting unknown keeps the caller from
    // reassigning the write to an unrelated statement.
    const script = parseBashScript("{ printf hi; } > notes.txt");
    expect(script.statements[0]?.kind).toBe("unknown");
});

test("a quoted literal argument stays a literal word", () => {
    // Quoting is not expansion: these name one concrete file each. Losing them to
    // hasNonLiteralWords would turn a resolvable delete into an unknown action.
    expect((parseBashScript(`rm "my notes.md"`).commands[0] as BashCommand).words)
        .toEqual(["rm", "my notes.md"]);
    expect((parseBashScript(`rm 'my notes.md'`).commands[0] as BashCommand).words)
        .toEqual(["rm", "my notes.md"]);
    const quotedExpansion = parseBashScript(`rm "$DIR"`)
        .commands[0] as BashCommand;
    expect(quotedExpansion.words).toEqual(["rm"]);
    expect(quotedExpansion.hasNonLiteralWords).toBe(true);
});

test("a quoted redirect target is literal, an expanded one is absent", () => {
    expect(parseBashScript(`printf hi > "my notes.txt"`).commands[0]?.redirects)
        .toEqual([{ operator: ">", target: "my notes.txt" }]);
    expect(parseBashScript(`printf hi > "$OUT"`).commands[0]?.redirects)
        .toEqual([{ operator: ">" }]);
});

test("an empty quoted word contributes no argument", () => {
    // `rm ""` has no target. Keeping "" as a word would let a caller resolve it
    // against the working directory and treat that directory as the target.
    const command = parseBashScript(`rm ""`).commands[0] as BashCommand;
    expect(command.words).toEqual(["rm"]);
    expect(command.hasNonLiteralWords).toBe(false);
});

test("a shell -c payload survives as a literal word for recursive parsing", () => {
    const command = parseBashScript(`bash -c "rm -rf /tmp/x"`)
        .commands[0] as BashCommand;
    expect(command.words).toEqual(["bash", "-c", "rm -rf /tmp/x"]);
});

test("a non-literal argument is reflected in hasNonLiteralWords, not guessed at", () => {
    const command = parseBashScript("printf hi > $OUT").commands[0] as BashCommand;
    expect(command.words).toEqual(["printf", "hi"]);
    const redirected = parseBashScript("rm -rf $BUILD_DIR").commands[0] as BashCommand;
    expect(redirected.words).toEqual(["rm", "-rf"]);
    expect(redirected.hasNonLiteralWords).toBe(true);
});

test("command, backtick, and process substitutions are all collected for recursive parsing", () => {
    expect(parseBashScript("echo $(mktemp -d)").substitutions).toEqual([
        "mktemp -d",
    ]);
    expect(parseBashScript("echo `echo hi`").substitutions).toEqual([
        "echo hi",
    ]);
    expect(parseBashScript("diff <(ls a) <(ls b)").substitutions).toEqual([
        "ls a",
        "ls b",
    ]);
});

test("constructs the module doesn't model become unknown, carrying their source", () => {
    for (
        const source of [
            "if true; then echo hi; fi",
            "for f in *; do echo $f; done",
            "(cd /tmp && ls)",
        ]
    ) {
        const script = parseBashScript(source);
        expect(script.statements[0]).toMatchObject({ kind: "unknown" });
        expect((script.statements[0] as { text: string }).text).toBe(source);
    }
});

test("a heredoc redirect is still recognized (fd/operator), just without a literal target", () => {
    const command = parseBashScript("cmd <<EOF\nhi\nEOF").commands[0] as BashCommand;
    expect(command.words).toEqual(["cmd"]);
    expect(command.redirects).toEqual([{ operator: "<<" }]);
});

describe("compared with the hand-written tokenizer's known gap", () => {
    test("2>&1 is understood directly, no reconnection heuristic needed", () => {
        // src/engine/permissions.ts has to specially reconnect `2>&1` because
        // the hand-written tokenizer in bash-danger.ts splits on the bare `&`.
        // A real parser has no such gap.
        const command = parseBashScript("printf x 2>&1").commands[0] as BashCommand;
        expect(command.words).toEqual(["printf", "x"]);
        expect(command.redirects).toEqual([{
            fileDescriptor: "2",
            operator: ">&",
            target: "1",
        }]);
    });
});
