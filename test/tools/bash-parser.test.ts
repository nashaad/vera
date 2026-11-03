import { beforeAll, describe, expect, test } from "bun:test";

import {
    initBashParser,
    isBashParserReady,
    commandsOf,
    parseBashScript,
    type BashChain,
    type BashCommand,
    type BashLoop,
    type BashPipeline,
} from "../../src/tools/bash-parser.ts";
import {
    nestedShellCommands,
    scannedExecutableIndex,
    shellCdIndex,
    simpleCommandExecutableIndex,
} from "../../src/tools/bash-danger.ts";
import {
    FULL_READING,
    scanReadings,
    scanSimpleCommands,
    type ScannedCommand,
} from "../../src/tools/bash-scan.ts";

beforeAll(async () => {
    await initBashParser();
});

function firstScanned(command: string): ScannedCommand {
    const [first] = scanSimpleCommands(command);
    if (first === undefined) {
        throw new Error(`no command in ${command}`);
    }
    return first;
}

function executableIndex(command: string): number {
    return scannedExecutableIndex(firstScanned(command));
}

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

test("a top-level statement or chain that ends in & marks its commands as background", () => {
    const backgrounds = (source: string): Array<true | undefined> =>
        parseBashScript(source).commands.map(({ background }) => background);
    expect(backgrounds("cd /tmp & ls")).toEqual([true, undefined]);
    expect(backgrounds("cd /tmp; ls &")).toEqual([undefined, true]);
    expect(backgrounds("cd /tmp && ls &")).toEqual([true, true]);
    expect(backgrounds("cd /tmp & ls & pwd")).toEqual([true, true, undefined]);
    expect(backgrounds("cd /tmp & # note\nls")).toEqual([true, undefined]);
    expect(backgrounds("while true; do cd /tmp & ls; done")).toEqual([undefined, true, undefined]);
    expect(backgrounds("cd /tmp\nls")).toEqual([undefined, undefined]);
    expect(backgrounds("cd /tmp &> out")).toEqual([undefined]);
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
            "select f in a b; do echo $f; done",
            "for f in a b; do echo $f; done > out.txt",
            "(cd /tmp && ls)",
        ]
    ) {
        const script = parseBashScript(source);
        expect(script.statements[0]).toMatchObject({ kind: "unknown" });
        expect((script.statements[0] as { text: string }).text).toBe(source);
    }
});

test("a non-literal word records where it sat among the literal ones", () => {
    const first = (source: string) =>
        (parseBashScript(source).commands[0] as BashCommand).firstNonLiteralIndex;
    expect(first("cat notes.md")).toBeUndefined();
    expect(first("cat $FILE")).toBe(1);
    expect(first("grep -n \"$PATTERN\" src")).toBe(2);
    // The name itself is dropped, so `cat` moves to index 0 and the index says
    // the first word is not the one that was written.
    expect(first("$TOOL cat notes.md")).toBe(0);
});

test("for, while, and until loops keep their condition and body", () => {
    const loop = parseBashScript("for f in a b; do cat $f; echo done; done")
        .statements[0] as BashLoop;
    expect(loop.kind).toBe("loop");
    expect(loop.condition).toEqual([]);
    expect(loop.body.map((statement) => (statement as BashCommand).words))
        .toEqual([["cat"], ["echo", "done"]]);

    const waiting = parseBashScript("until ls out.txt; cat in.txt; do sleep 1; done")
        .statements[0] as BashLoop;
    expect(waiting.condition.map((statement) => (statement as BashCommand).words))
        .toEqual([["ls", "out.txt"], ["cat", "in.txt"]]);
    expect(waiting.body.map((statement) => (statement as BashCommand).words))
        .toEqual([["sleep", "1"]]);
});

test("commands inside a loop are collected with the rest of the script", () => {
    // shellCommandPayloads reads script.commands; a bash -c inside a loop body
    // must not hide from it.
    const script = parseBashScript(
        "while ls a; do bash -c \"rm -rf x\"; done; pwd",
    );
    expect(script.commands.map((command) => command.words[0]))
        .toEqual(["ls", "bash", "pwd"]);
    expect(commandsOf(script.statements[0]!).map((command) => command.words[0]))
        .toEqual(["ls", "bash"]);
});

test("a heredoc redirect is still recognized (fd/operator), just without a literal target", () => {
    const command = parseBashScript("cmd <<EOF\nhi\nEOF").commands[0] as BashCommand;
    expect(command.words).toEqual(["cmd"]);
    expect(command.redirects).toEqual([{ operator: "<<" }]);
});

describe("redirections that contain `&`", () => {
    test("2>&1 is one redirection, not a background command", () => {
        const command = parseBashScript("printf x 2>&1").commands[0] as BashCommand;
        expect(command.words).toEqual(["printf", "x"]);
        expect(command.redirects).toEqual([{
            fileDescriptor: "2",
            operator: ">&",
            target: "1",
        }]);
    });
});

describe("the shell scanner behind the accident guard", () => {
    function commandWords(command: string): string[][] {
        return scanSimpleCommands(command).map(({ words }) => words);
    }

    function scripts(command: string): string[] {
        return nestedShellCommands(command).map(({ script }) => script);
    }

    test("a # right after a substitution is part of the word, not a comment", () => {
        expect(commandWords("echo $(true)#; rm -rf /")).toContainEqual(["rm", "-rf", "/"]);
        expect(commandWords("echo `true`#; rm -rf /")).toContainEqual(["rm", "-rf", "/"]);
        expect(commandWords("echo $((1))#; rm -rf /")).toContainEqual(["rm", "-rf", "/"]);
        expect(scripts("echo $(true)#; echo \"$(rm -rf /)\"")).toContain("rm -rf /");
    });

    test("a # that starts a word is a comment", () => {
        expect(commandWords("echo hi # rm -rf /")).toEqual([["echo", "hi"]]);
        expect(commandWords("echo hi;# rm -rf /")).toEqual([["echo", "hi"]]);
        expect(commandWords("echo ${#PATH} $# a#b")).toEqual([["echo", "${#PATH}", "$#", "a#b"]]);
    });

    test("a # after ) or an opening backtick starts a comment", () => {
        const removal = ["rm", "-rf", "/"];
        expect(commandWords("(true)#'\nrm -rf /")).toContainEqual(removal);
        expect(commandWords("((1))#'\nrm -rf /")).toContainEqual(removal);
        expect(commandWords("echo `#'`\nrm -rf /")).toContainEqual(removal);
        expect(commandWords("case x in x)#'\nrm -rf /;; esac"))
            .toContainEqual(removal);
    });

    test("a # after the end of a substitution or an arithmetic expansion is text", () => {
        const removal = ["rm", "-rf", "/"];
        expect(commandWords("echo $(true)#'; rm -rf /'")).not.toContainEqual(removal);
        expect(commandWords("echo $((1))#'; rm -rf /'")).not.toContainEqual(removal);
        expect(commandWords("echo `true`#'; rm -rf /'")).not.toContainEqual(removal);
    });

    test("a # after <(, >(, a=( and a continued $( is text", () => {
        const removal = ["rm", "-rf", "/"];
        for (const command of [
            "cat <(true)#'; rm -rf /'",
            "echo >(true)#'; rm -rf /'",
            "a=(1)#'; rm -rf /'",
            "a+=(1)#'; rm -rf /'",
            "echo $\\\n(true)#'; rm -rf /'",
            "cat <((1))#'; rm -rf /'",
            "echo $(( `((1))` ))#'; rm -rf /'",
        ]) {
            expect(commandWords(command), command).not.toContainEqual(removal);
        }
        for (const command of [
            "f()#'\nrm -rf /",
            "! (true)#'\nrm -rf /",
            "!(true)#'\nrm -rf /",
            "f@()#'\nrm -rf /",
            "f+()#'\nrm -rf /",
            "f?()#'\nrm -rf /",
            "f*()#'\nrm -rf /",
            "f!()#'\nrm -rf /",
            "echo @(a|b)#'\nrm -rf /",
            "a=(1) #'\nrm -rf /",
            "cat <(true) #'\nrm -rf /",
        ]) {
            expect(commandWords(command), command).toContainEqual(removal);
        }
    });

    test("a backslash-newline inside <<, <( or >( joins the operator", () => {
        const removal = ["rm", "-rf", "/"];
        for (const command of [
            "cat <\\\n<EOF\n'\nEOF\nrm -rf /",
            "cat <\\\n<\\\nEOF\n'\nEOF\nrm -rf /",
            "cat <<\\\nEOF\n'\nEOF\nrm -rf /",
            ": # '\ncat <\\\n(true)#x; rm -rf /\n# '",
            ": # '\necho >\\\n(true)#x; rm -rf /\n# '",
            ": # '\necho >\\\n\\\n(true)#x; rm -rf /\n# '",
        ]) {
            expect(commandWords(command), command).toContainEqual(removal);
        }
        expect(scanSimpleCommands("cat <\\\n<EOF\nhi\nEOF")[0]?.hereDocuments)
            .toEqual(["hi"]);
        expect(commandWords("echo a\\\n<b")).toEqual([["echo", "a<b"]]);
    });

    test("a # after a group that follows ?, *, +, @ or ! is text only under the patternGroups reading", () => {
        const removal = ["rm", "-rf", "/"];
        const patternGroups = { comments: true, hereDocuments: true, patternGroups: true };
        for (const command of [
            "echo @(a|b)#'; rm -rf /'",
            "echo !(a)#'; rm -rf /'",
            "echo +(a)#'; rm -rf /'",
            "echo ?(a)#'; rm -rf /'",
            "echo *(a)#'; rm -rf /'",
        ]) {
            const words = scanSimpleCommands(command, patternGroups).map((scanned) => scanned.words);
            expect(words, command).not.toContainEqual(removal);
        }
        const words = (command: string) => scanSimpleCommands(command, patternGroups).map((scanned) => scanned.words);
        expect(words("echo @(a|b)#x; rm -rf /")).toContainEqual(removal);
        expect(words("f@()#'\nrm -rf /")).not.toContainEqual(removal);
        expect(commandWords("echo @(a|b)#x; rm -rf /")).not.toContainEqual(removal);
    });

    test("$$ followed by a quote is the process id, so the quote is not ANSI-C", () => {
        expect(commandWords("echo $$'\\'; rm -rf / #'")).toEqual([
            ["echo", "$$\\"],
            ["rm", "-rf", "/"],
        ]);
        expect(commandWords("echo $'a\\x41'")).toEqual([["echo", "aA"]]);
    });

    test("$$$' is the process id followed by ANSI-C quoting", () => {
        expect(commandWords("echo $$$'\\'' ; rm -rf / #'")).toEqual([
            ["echo", "$$'"],
            ["rm", "-rf", "/"],
        ]);
    });

    test("a comment inside backticks ends at the closing backtick", () => {
        expect(commandWords("echo `true # x`; rm -rf /")).toContainEqual(["rm", "-rf", "/"]);
    });

    test("with comments off a # is part of the word", () => {
        expect(scanSimpleCommands("echo hi # x; rm -rf /", { comments: false, hereDocuments: true }).map(({ words }) => words))
            .toEqual([["echo", "hi", "#", "x"], ["rm", "-rf", "/"]]);
        expect(commandWords("echo ${x:- #}; rm -rf /")).toEqual([["echo", "${x:-"]]);
    });

    test("an expansion left open in backticks ends with the backticks", () => {
        const scanned = scanSimpleCommands("echo `echo ${`; cat <<'EOF'\ndon't\nEOF\nrm -rf /");
        expect(scanned.find(({ words }) => words[0] === "cat")?.hereDocuments)
            .toEqual(["don't"]);
        expect(scanned.at(-1)?.words).toEqual(["rm", "-rf", "/"]);
    });

    test("<< inside $[...] or ${...} starts no here-document", () => {
        const quotedScript = "bash -c \"true\nrm -rf x\"";
        const expansions = [
            "$[1<<4]",
            "$[a[1]<<2]",
            "${x:-a<<b}",
            "${x:-\"}\"<<b}",
            "${x:-(<<b}",
            "${x:-$(echo })<<b}",
            "${x:-`true`<<b}",
        ];
        for (const expansion of expansions) {
            const scanned = scanSimpleCommands(`echo ${expansion}\n${quotedScript}`);
            expect(scanned.flatMap(({ hereDocuments }) => hereDocuments), expansion).toEqual([]);
            expect(scanned.at(-1)?.words, expansion).toEqual(["bash", "-c", "true\nrm -rf x"]);
        }
        const real = scanSimpleCommands("cat ${x:-a} $[1<<4] <<EOF\nhi\nEOF");
        expect(real[0]?.hereDocuments).toEqual(["hi"]);
    });

    test("a here-document at the start of the command ends at its delimiter", () => {
        expect(commandWords("<<EOF cat\n'\nEOF\nrm -rf /")).toContainEqual(["rm", "-rf", "/"]);
        expect(scripts("<<'EOF' cat\nrm -rf /\nEOF")).toContain("rm -rf /");
    });

    test("every here-document body and here-string is a nested script", () => {
        expect(scripts("eval bash <<< 'rm -rf /'")).toContain("rm -rf /");
        expect(scripts("eval cat <<< 'rm -rf /'")).toContain("rm -rf /");
        expect(scripts("cat <<'EOF'\nrm -rf /\nEOF")).toContain("rm -rf /");
        expect(scripts("{ bash; } <<< 'rm -rf /'")).toContain("rm -rf /");
        expect(scripts("cat x<<<'rm -rf /'")).toContain("rm -rf /");
        expect(scripts("echo '<<<' 'rm -rf /'")).toEqual([]);
    });

    test("a here-document delimiter is unreadable when it holds an expansion", () => {
        const flagged = (command: string): boolean =>
            scanSimpleCommands(command).some(
                ({ unreadableDelimiter }) => unreadableDelimiter,
            );
        for (const command of [
            "cat <<E$(x)F\nhi\nE$(x)F",
            "cat <<E$((1))F\nhi\nE$((1))F",
            "cat <<E`x`F\nhi\nE`x`F",
            "cat <<${x:-a b}\nhi\n${x:-a b}",
            "cat <<$[1 + 2]\nhi\n$[1 + 2]",
            "cat << E$(x)F\nhi\nE$(x)F",
            "cat <<-E$(x)F\nhi\nE$(x)F",
            "cat 2<<E$(x)F\nhi\nE$(x)F",
            "cat <<\"E$(x)F\"\nhi\nE$(x)F",
            "cat <<\\-x\nhi\n-x",
            "cat <<'-'x\nhi\n-x",
            "cat <<\"-x\"\nhi\n-x",
            "cat 2<<\\- x\nhi\n-",
            "cat {fd}<<\\-x\nhi\n-x",
            "cat {fd}<< E$(x)F\nhi\nE$(x)F",
            "cat {fd}<<E$(x)F>out\nhi\nE$(x)F",
            "cat <<E$(x)F>out\nhi\nE$(x)F",
            "cat <<EOF`x`\nhi\nEOF",
            "cat <<`x`\nhi\nEOF",
        ]) {
            expect(flagged(command), command).toBe(true);
        }
        for (const command of [
            "cat <<'E$(x)F'\nhi\nE$(x)F",
            "cat << 'E`x`F'\nhi\nE`x`F",
            "cat <<E\\$\\(x)\nhi\nE$(x)",
            "cat <<EOF\nhi\nEOF\necho $(x) `y`",
            "cat <<EOF $(x)\nhi\nEOF",
            "x=$(cat <<EOF)",
            "echo $((1<<$(x)))",
            "cat <<< $(x)",
            "cat <<<E$(x)",
            "cat <<-EOF\n\thi\n\tEOF",
            "cat <<-'EOF'\n\thi\n\tEOF",
            "cat << -x\nhi\n-x",
            "cat <<x-\nhi\nx-",
            "cat <<\"\" $(x)\n\n",
            "cat <<EOF>${x}\nhi\nEOF",
            "cat <<EOF>\"$(x)\"\nhi\nEOF",
            "cat <<EOF<${x}\nhi\nEOF",
            "cat <<EOF >${x}\nhi\nEOF",
            "cat <<'EOF'\nUse `cat <<EOF` here.\nEOF",
            "git commit -F - <<'EOF'\nrefuse `<<` here\nEOF",
            "echo `cat <<EOF`\nhi\nEOF",
        ]) {
            expect(flagged(command), command).toBe(false);
        }
        // The scanner splits the delimiter at `$(`; only that command is flagged.
        const flags = scanSimpleCommands("cat <<E$(x)F\nhi\nE$(x)F\necho hi")
            .map(({ unreadableDelimiter }) => unreadableDelimiter);
        expect(flags.filter((flag) => flag)).toHaveLength(1);
        expect(flags.at(-1)).toBe(false);
    });

    test("<<< ends the word before it, like <<", () => {
        expect(commandWords("cat x<<<y")).toEqual([["cat", "x", "<<<y"]]);
        expect(commandWords("cat 2<<<y")).toEqual([["cat", "2<<<y"]]);
    });

    test("a redirection is flagged only where the operator is unquoted", () => {
        const [scanned] = scanSimpleCommands("eval '>x' >y 2>&1 > z \\>w 2'>'v");
        expect(scanned?.words).toEqual(["eval", ">x", ">y", "2>&1", ">", "z", ">w", "2>v"]);
        expect(scanned?.redirectWidths).toEqual([0, 0, 1, 1, 2, 0, 0, 0]);
    });

    test("eval and exec drop only the redirections the shell reads", () => {
        expect(scripts("eval '>x' rm -rf /")).toEqual([">x rm -rf /"]);
        expect(scripts("eval >x rm -rf /")).toEqual(["rm -rf /"]);
        expect(scripts("eval '>' 'x; rm -rf /'")).toEqual(["> x; rm -rf /"]);
        expect(scripts("exec -a '>x' bash -c 'rm -rf /'")).toEqual([
            "'bash' '-c' 'rm -rf /'",
        ]);
    });

    test("exec with only redirects runs nothing", () => {
        expect(scripts("exec >log 2>&1; echo hi")).toEqual([]);
        expect(scripts("exec 3<&-")).toEqual([]);
    });

    test("a nested script names the scanned command that runs it", () => {
        const found = nestedShellCommands("cd /tmp; eval 'rm -rf .'; echo $(true)");
        expect(found.map(({ script, commandIndex }) => [script, commandIndex])).toEqual([
            ["true", undefined],
            ["rm -rf .", 1],
        ]);
    });

    test("env reads -P and a \\_ in -S as a separator", () => {
        expect(executableIndex("env -P /bin rm -rf /")).toBe(3);
        expect(scripts("env -S 'rm\\_-rf\\_/'")).toEqual([
            "env rm\\_-rf\\_/ ",
            "env 'rm' '-rf' '/' ",
        ]);
    });

    test("env -S is read with the shell's quoting and with its own", () => {
        expect(scripts("env -S \"X='a\\' b ' rm -rf / ''\"")).toEqual([
            "env X='a\\' b ' rm -rf / '' ",
            "env 'X=a'\\'' b ' 'rm' '-rf' '/' '' ",
        ]);
        expect(scripts("env -S 'a\\_\"b\\_c\" d\\ce'")[1]).toBe("env 'a' 'b c' 'd' ");
    });

    test("a lone + after -c is the script, and a find + ends -exec only after {}", () => {
        expect(scripts("bash -c + 'rm -rf /'")).toEqual(["rm -rf /"]);
        expect(scripts("find . -exec echo + \\; -exec sh -c 'rm -rf /' \\;")).toEqual([
            "'echo' '+'",
            "'sh' '-c' 'rm -rf /'",
        ]);
        expect(scripts("find . -exec echo {} + -exec sh -c 'rm -rf /' \\;")).toEqual([
            "'echo' '{}'",
            "'sh' '-c' 'rm -rf /'",
        ]);
    });

    test("find -exec runs in the starting directory and -execdir in the directory of each match", () => {
        const directoryKnown = (command: string): boolean[] =>
            nestedShellCommands(command).map((nested) => nested.directoryKnown);
        expect(directoryKnown("find . -exec sh -c 'rm -rf .' \\;")).toEqual([true]);
        expect(directoryKnown("find . -ok sh -c 'rm -rf .' \\;")).toEqual([true]);
        expect(directoryKnown("find . -execdir sh -c 'rm -rf .' \\;")).toEqual([false]);
        expect(directoryKnown("find . -okdir sh -c 'rm -rf .' \\;")).toEqual([false]);
    });

    test("a here-document opens inside backticks even when the backticks sit in an expansion", () => {
        const body = (command: string): string[] | undefined =>
            scanSimpleCommands(command)
                .find(({ words }) => words.includes("cat"))?.hereDocuments;
        expect(body("echo ${x:-`cat <<EOF\nbody\nEOF\n`}")).toEqual(["body"]);
        expect(body("echo $(( `cat <<EOF\nbody\nEOF\n` ))")).toEqual(["body"]);
    });

    test("a closer ends only the innermost expansion it matches", () => {
        const scanned = scanSimpleCommands("echo ${x:-$(cat } <<b)}\nhi\nb");
        expect(scanned.find(({ words }) => words.includes("cat"))?.hereDocuments)
            .toEqual(["hi"]);
    });

    test("with here-documents off the lines after << are ordinary commands", () => {
        const reading = { comments: true, hereDocuments: false };
        const scanned = scanSimpleCommands("cat <<EOF\nrm -rf /\nEOF", reading);
        expect(scanned.map(({ words }) => words)).toEqual([
            ["cat", "<<EOF"],
            ["rm", "-rf", "/"],
            ["EOF"],
        ]);
        expect(scanned[0]?.hereDocuments).toEqual([]);
    });

    test("scanReadings pairs each here-document setting with each comment setting", () => {
        expect(scanReadings("echo hi")).toEqual([FULL_READING]);
        expect(scanReadings("cat <<EOF")).toHaveLength(2);
        expect(scanReadings("echo hi # x")).toHaveLength(2);
        expect(scanReadings("cat <<EOF # x\nEOF")).toHaveLength(4);
        // The `#` is a comment only when the body is read as commands.
        expect(scanReadings("cat <<EOF\necho a #b\nEOF")).toEqual([
            { comments: true, hereDocuments: true },
            { comments: true, hereDocuments: false },
            { comments: false, hereDocuments: false },
        ]);
        expect(scanReadings("echo ${#x}")).toEqual([FULL_READING]);
    });

    test("scanReadings adds the patternGroups reading only for a # beside a ?, *, +, @ or ! group", () => {
        expect(scanReadings("echo @(a) x")).toEqual([FULL_READING]);
        expect(scanReadings("echo a # x")).toEqual([
            FULL_READING,
            { comments: false, hereDocuments: true },
        ]);
        expect(scanReadings("echo @(a)#x")).toContainEqual({
            comments: true,
            hereDocuments: true,
            patternGroups: true,
        });
        expect(scanReadings("echo @\\\n(a)#x")).toContainEqual({
            comments: true,
            hereDocuments: true,
            patternGroups: true,
        });
        expect(scanReadings("f!()#x\ncat <<EOF\nEOF")).toHaveLength(6);
    });

    test("the scanner marks a command that follows a ) or a closing backtick", () => {
        const after = (command: string): boolean[] =>
            scanSimpleCommands(command).map(({ afterParen }) => afterParen);
        expect(after("case x in x) time cd /tmp;; esac")).toEqual([false, true, false]);
        expect(after("case x in (x) time cd /tmp;; esac")).toEqual([false, false, true, false]);
        expect(after("case x in\nx) time cd /tmp;; esac")).toEqual([false, false, true, false]);
        expect(after("echo `date` time cd /tmp")).toEqual([false, false, true]);
        expect(after("(true) ; time cd /tmp")).toEqual([false, false]);
        expect(after("true; time cd /tmp")).toEqual([false, false]);
        expect(after("echo a && time cd /tmp")).toEqual([false, false]);
    });

    test("the scanner marks only unquoted assignments and redirections", () => {
        const [command] = scanSimpleCommands("A=1 'B=2' >x '>y' \\>z 2>&1 > t cd");
        expect(command?.assignments)
            .toEqual([true, false, false, false, false, false, false, false, false]);
        expect(command?.redirectWidths).toEqual([0, 0, 1, 0, 0, 1, 2, 0, 0]);
    });

    test("the scanner reads += and a simple subscript as part of an assignment", () => {
        const [command] = scanSimpleCommands("A+=1 A[0]=1 A[i]+=x 'B[0]=1' A[1]x=2 rm");
        expect(command?.assignments).toEqual([true, true, true, false, false, false]);
        expect(executableIndex("A[i]+=x A+=1 rm -rf /")).toBe(2);
        expect(executableIndex("{ A+=1 rm -rf /")).toBe(2);
        expect(executableIndex("A[1]x=2 rm")).toBe(0);
        expect(simpleCommandExecutableIndex(["A+=1", "A[0]=1", "rm", "-rf", "/"])).toBe(2);
    });

    test("a {name} before a redirection names its descriptor and stays in the word", () => {
        const [command] = scanSimpleCommands("{fd}>x {fd}> y {fd}>&- {fd}<<<z x{fd}>y {1a}>y rm");
        expect(command?.words)
            .toEqual(["{fd}>x", "{fd}>", "y", "{fd}>&-", "{fd}<<<z", "x{fd}>y", "{1a}>y", "rm"]);
        expect(command?.redirectWidths).toEqual([1, 2, 0, 1, 1, 0, 0, 0]);
        expect(executableIndex("{fd}<<<x rm -rf /")).toBe(1);
        expect(executableIndex("{ {fd}>x rm -rf /")).toBe(2);
        expect(executableIndex("{fd}> x rm -rf /")).toBe(2);
        expect(executableIndex("{1a}>x rm")).toBe(0);
    });

    test("a {name} before << or <<< still opens a here-document or reads a here-string", () => {
        expect(scripts("cat {fd}<<<'rm -rf /'")).toContain("rm -rf /");
        expect(commandWords("cat {fd}<<EOF\nrm -rf /\nEOF")).toContainEqual(["rm", "-rf", "/"]);
        expect(commandWords("{fd}<<-EOF cat\n\trm -rf /\n\tEOF")).toContainEqual(["rm", "-rf", "/"]);
        expect(commandWords("cat {fd}<<EOF\nrm -rf /\nEOF")).not.toContainEqual(["EOF"]);
    });

    test("shellCdIndex finds only a cd that changes the directory of the shell", () => {
        const cdIndex = (command: string): number | undefined => {
            const scanned = firstScanned(command);
            return shellCdIndex(scanned.words, scanned);
        };
        expect(cdIndex("cd /tmp")).toBe(0);
        expect(cdIndex("time cd /tmp")).toBe(1);
        expect(cdIndex("command cd /tmp")).toBe(1);
        expect(cdIndex("builtin cd /tmp")).toBe(1);
        expect(cdIndex("command -p cd /tmp")).toBe(2);
        expect(cdIndex("A=1 >x cd /tmp")).toBe(2);
        expect(cdIndex("env cd /tmp")).toBeUndefined();
        expect(cdIndex("env -P /bin cd /tmp")).toBeUndefined();
        expect(cdIndex("command env cd /tmp")).toBeUndefined();
        expect(cdIndex("command -v cd /tmp")).toBeUndefined();
        expect(cdIndex("/usr/bin/cd /tmp")).toBeUndefined();
        expect(cdIndex("xargs cd /tmp")).toBeUndefined();
        expect(cdIndex("'>x' cd /tmp")).toBeUndefined();
        expect(cdIndex("'A=1' cd /tmp")).toBeUndefined();
        expect(cdIndex("'time' cd /tmp")).toBeUndefined();
        expect(cdIndex("builtin -- cd /tmp")).toBe(2);
        expect(cdIndex("time >x cd /tmp")).toBe(2);
        expect(cdIndex("! >x cd /tmp")).toBe(2);
        expect(cdIndex("time A=1 cd /tmp")).toBe(2);
        expect(shellCdIndex(["cd", "/tmp"])).toBe(0);
        expect(shellCdIndex(["env", "cd", "/tmp"])).toBeUndefined();
    });

    test("shellCdIndex reads a reserved word only where a command starts", () => {
        const cdIndex = (command: string): number | undefined => {
            const scanned = firstScanned(command);
            return shellCdIndex(scanned.words, scanned);
        };
        for (const command of [
            "builtin time cd /tmp", "builtin builtin time cd /tmp",
            "builtin ! cd /tmp", ">x time cd /tmp", "<x time cd /tmp",
            "2>/dev/null time cd /tmp", "2>&1 time cd /tmp",
            ">/dev/null ! cd /tmp", "A=1 time cd /tmp", "A=1 ! cd /tmp",
            "command time cd /tmp", "command -p time cd /tmp",
        ]) {
            expect(cdIndex(command), command).toBeUndefined();
        }
    });

    test("shellCdIndex can read time after a control word as a program", () => {
        const cdIndex = (command: string, timeAfterControlWord: boolean): number | undefined => {
            const scanned = firstScanned(command);
            return shellCdIndex(scanned.words, scanned, timeAfterControlWord);
        };
        for (const command of [
            "if time cd /tmp", "while time cd /tmp", "until time cd /tmp",
            "elif time cd /tmp", "! time cd /tmp", "time time cd /tmp",
            "if ! time cd /tmp",
        ]) {
            expect(cdIndex(command, true), command).toBeDefined();
            expect(cdIndex(command, false), command).toBeUndefined();
        }
        for (const command of [
            "time cd /tmp", "{ time cd /tmp", "do time cd /tmp",
            "then time cd /tmp", "else time cd /tmp", "if cd /tmp",
        ]) {
            expect(cdIndex(command, false), command).toBe(cdIndex(command, true));
            expect(cdIndex(command, false), command).toBeDefined();
        }
    });

    test("shellCdIndex skips -p and -- after time only where bash reads time as reserved", () => {
        const cdIndex = (command: string, timeAfterControlWord = true): number | undefined => {
            const scanned = firstScanned(command);
            return shellCdIndex(scanned.words, scanned, timeAfterControlWord);
        };
        expect(cdIndex("time -p cd /tmp")).toBe(2);
        expect(cdIndex("time -- cd /tmp")).toBe(2);
        expect(cdIndex("time -p -- cd /tmp")).toBe(3);
        expect(cdIndex("time -p ! cd /tmp")).toBe(3);
        expect(cdIndex("time -p cd /tmp", false)).toBeUndefined();
        expect(cdIndex("time -p ! cd /tmp", false)).toBeUndefined();
        expect(cdIndex("time -- cd /tmp", false)).toBeUndefined();
        expect(cdIndex("time -p -- cd /tmp", false)).toBeUndefined();
        expect(cdIndex("time -p time cd /tmp")).toBe(3);
        expect(cdIndex("time -p time cd /tmp", false)).toBeUndefined();
        expect(cdIndex("time '-p' cd /tmp")).toBeUndefined();
        expect(cdIndex("time -x cd /tmp")).toBeUndefined();
        expect(cdIndex("time cd -p /tmp")).toBe(1);
        expect(cdIndex("cd -p /tmp")).toBe(0);
        expect(simpleCommandExecutableIndex(["time", "-p", "--", "rm"])).toBe(3);
    });

    test("shellCdIndex reads time after a case pattern as a program only in the older bash", () => {
        const cdIndex = (command: string, timeAfterControlWord: boolean): number | undefined => {
            const scanned = scanSimpleCommands(command).find(({ words }) => words.includes("cd"));
            if (scanned === undefined) {
                throw new Error(`no cd in ${command}`);
            }
            return shellCdIndex(scanned.words, scanned, timeAfterControlWord);
        };
        for (const command of [
            "case x in x) time cd /tmp;; esac",
            "case x in (x) time cd /tmp;; esac",
            "case x in\nx) time cd /tmp;; esac",
        ]) {
            expect(cdIndex(command, true), command).toBe(1);
            expect(cdIndex(command, false), command).toBeUndefined();
        }
        for (const command of [
            "case x in x) true; time cd /tmp;; esac",
            "case x in x) { time cd /tmp; };; esac",
            "case x in x) ! cd /tmp;; esac",
            "case x in x) cd /tmp;; esac",
        ]) {
            expect(cdIndex(command, false), command).toBe(cdIndex(command, true));
            expect(cdIndex(command, false), command).toBeDefined();
        }
    });

    test("coproc is skipped before the command, with or without a name", () => {
        for (const [command, expected] of [
            ["coproc rm -rf /", 1],
            ["coproc { rm -rf /", 2],
            ["coproc X { rm -rf /", 3],
            ["coproc X while rm -rf /", 3],
            ["coproc X if rm -rf /", 3],
            ["! coproc rm -rf /", 2],
            ["time -p coproc rm -rf /", 3],
            ["coproc X rm -rf /", 1],
            ["coproc ls", 1],
        ] as const) {
            expect(executableIndex(command), command).toBe(expected);
        }
        const scanned = firstScanned("coproc cd /tmp");
        expect(shellCdIndex(scanned.words, scanned)).toBeUndefined();
        expect(simpleCommandExecutableIndex(["coproc", "X", "{", "rm", "-rf", "/"])).toBe(3);
    });

    test("a reserved word can be followed by assignments and redirects, and those by another reserved word", () => {
        for (const [command, expected] of [
            ["{ 2>/dev/null rm -rf /", 2],
            ["{ A=1 rm -rf /", 2],
            ["{ <<<x rm -rf /", 2],
            ["{ <<< x rm -rf /", 3],
            ["! >/dev/null rm -rf /", 2],
            ["! > /dev/null rm -rf /", 3],
            ["! A=1 rm -rf /", 2],
            ["time A=1 rm -rf /", 2],
            ["time -p 2>/dev/null rm -rf /", 3],
            ["if A=1 rm -rf /", 2],
            ["do 2>&1 rm -rf /", 2],
            ["coproc A=1 rm -rf /", 2],
            ["A=1 ! >x time rm -rf /", 4],
            ["{ ls", 1],
            ["! >/dev/null grep x y", 2],
        ] as const) {
            expect(executableIndex(command), command).toBe(expected);
        }
        expect(simpleCommandExecutableIndex(["{", "A=1", "rm", "-rf", "/"])).toBe(2);
        expect(simpleCommandExecutableIndex(["!", "A=1", "rm"])).toBe(2);
        const scanned = firstScanned("! A=1 cd /tmp");
        expect(shellCdIndex(scanned.words, scanned)).toBe(2);
    });

    test("function skips its name and runs no cd here", () => {
        for (const [command, expected] of [
            ["function f { rm -rf /", 3],
            ["function f { 2>/dev/null rm -rf /", 4],
            ["function time { rm -rf /", 3],
            ["! function f { rm -rf /", 4],
            ["function f", 2],
            ["function", 1],
            ["echo function f", 0],
        ] as const) {
            expect(executableIndex(command), command).toBe(expected);
        }
        const scanned = firstScanned("function f { cd /tmp");
        expect(shellCdIndex(scanned.words, scanned)).toBeUndefined();
    });

    test("builtin takes only -- and command only -p, -v and -V", () => {
        const cdIndex = (command: string): number | undefined => {
            const scanned = firstScanned(command);
            return shellCdIndex(scanned.words, scanned);
        };
        for (const command of [
            "builtin -p cd /tmp", "builtin -x cd /tmp", "builtin -v cd /tmp",
            "command -x cd /tmp", "command -pv cd /tmp", "command -V cd /tmp",
        ]) {
            expect(cdIndex(command), command).toBeUndefined();
        }
        expect(cdIndex("command -- cd /tmp")).toBe(2);
        expect(cdIndex("command -pp cd /tmp")).toBe(2);
        expect(cdIndex("builtin builtin cd /tmp")).toBe(2);
        expect(cdIndex("command builtin cd /tmp")).toBe(2);
    });

    test("a quoted time is skipped to find the program, but a quoted redirection is a name", () => {
        expect(executableIndex("'time' rm -rf /")).toBe(1);
        expect(executableIndex("'>x' rm -rf /")).toBe(0);
        expect(executableIndex(">x rm -rf /")).toBe(1);
    });

    test("env takes any word with an = as an assignment", () => {
        expect(executableIndex("env 'a-b=c' rm -rf /")).toBe(2);
    });

    test("xargs and find drop their own redirections before the program", () => {
        expect(scripts("xargs 2>/dev/null sh -c 'rm -rf /'")).toEqual([
            "'sh' '-c' 'rm -rf /'",
        ]);
        expect(scripts("find . 2>/dev/null -exec sh -c 'rm -rf /' \;")).toEqual([
            "'sh' '-c' 'rm -rf /'",
        ]);
        expect(scripts("find . -exec sh -c 'rm -rf /' 2>/dev/null \;")).toEqual([
            "'sh' '-c' 'rm -rf /'",
        ]);
    });

    test("an ANSI-C string ends at the first NUL it decodes", () => {
        expect(commandWords("echo $'a\\0b'c")).toEqual([["echo", "ac"]]);
        expect(commandWords("echo $'a\\x00b'c")).toEqual([["echo", "ac"]]);
        expect(commandWords("echo $'a\\400b'c")).toEqual([["echo", "ac"]]);
        expect(commandWords("echo $'a\\c@b'c")).toEqual([["echo", "ac"]]);
        expect(commandWords("echo $'a\\0\\'b'c; ls")).toEqual([
            ["echo", "ac"],
            ["ls"],
        ]);
    });

    test("an ANSI-C octal escape wraps to a byte and \\c makes a control character", () => {
        expect(commandWords("echo $'/\\457'")).toEqual([["echo", "//"]]);
        expect(commandWords("echo $'a\\cab'")).toEqual([["echo", "a\u0001b"]]);
        expect(commandWords("echo $'a\\c?b'")).toEqual([["echo", "a\u007fb"]]);
        expect(commandWords("echo $'a\\c1b'")).toEqual([["echo", "a\u0011b"]]);
        expect(commandWords("echo $'a\\c[b'")).toEqual([["echo", "a\u001bb"]]);
        expect(commandWords("echo $'a\\c b'c")).toEqual([["echo", "ac"]]);
        expect(commandWords("echo $'a\\c`b'c")).toEqual([["echo", "ac"]]);
    });

    test("a long body line of commands is scanned without overflowing the stack", () => {
        const scanned = scanSimpleCommands(`cat <<EOF\n${"a;".repeat(1_000_000)}\nEOF`);
        expect(scanned).toHaveLength(1_000_001);
    });

    test("many backtick pairs inside open expansions are scanned in linear time", () => {
        const command = `echo ${"${".repeat(100_000)}${"``".repeat(100_000)}`;
        const start = performance.now();
        scanSimpleCommands(command);
        expect(performance.now() - start).toBeLessThan(1000);
    });
});
