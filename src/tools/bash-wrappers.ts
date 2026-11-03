import type { ScannedCommand } from "./bash-scan.ts";

export interface NestedScript {
    readonly script: string;
    // `find -execdir` runs in the directory of each match, not ours.
    readonly directoryKnown: boolean;
}

const FIND_EXEC_OPTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_PER_MATCH_DIRECTORY_OPTIONS = new Set(["-execdir", "-okdir"]);

// `-e`, `-i` and `-l` take their value attached (`-i{}`), never separate.
const XARGS_SHORT_OPTIONS_WITH_VALUE = new Set([
    "a",
    "d",
    "E",
    "I",
    "J",
    "L",
    "n",
    "P",
    "R",
    "s",
    "S",
]);
const XARGS_SHORT_OPTIONS_WITH_ATTACHED_VALUE = new Set(["e", "i", "l"]);
const XARGS_LONG_OPTIONS_WITH_VALUE = new Set([
    "--arg-file",
    "--delimiter",
    "--max-args",
    "--max-chars",
    "--max-procs",
    "--process-slot-var",
]);

export function quoteWords(words: readonly string[]): string {
    return words
        .map((word) => `'${word.replaceAll("'", "'\\''")}'`)
        .join(" ");
}

export function wrappedCommandScripts(
    executable: string,
    command: ScannedCommand,
    executableIndex: number,
): NestedScript[] {
    if (executable === "eval") {
        return evalScripts(command, executableIndex + 1);
    }
    if (executable === "exec") {
        return scriptOf(execCommandWords(command, executableIndex + 1), true);
    }
    if (executable === "xargs") {
        return scriptOf(
            xargsCommandWords(withoutRedirects(command, executableIndex + 1)),
            true,
        );
    }
    if (executable === "find") {
        return findExecScripts(withoutRedirects(command, executableIndex + 1));
    }
    return [];
}

function scriptOf(
    words: readonly string[],
    directoryKnown: boolean,
): NestedScript[] {
    return words.length === 0
        ? []
        : [{ script: quoteWords(words), directoryKnown }];
}

// `eval` joins its arguments with spaces and reads the result as a script.
function evalScripts(
    command: ScannedCommand,
    start: number,
): NestedScript[] {
    const evalWords = withoutRedirects(command, start);
    if (evalWords[0] === "--") {
        evalWords.shift();
    }
    return evalWords.length === 0
        ? []
        : [{ script: evalWords.join(" "), directoryKnown: true }];
}

// Redirections belong to `exec` itself: `exec >log 2>&1` runs nothing.
function execCommandWords(
    command: ScannedCommand,
    start: number,
): readonly string[] {
    const commandWords = withoutRedirects(command, start);
    let index = 0;
    while (index < commandWords.length) {
        const word = commandWords[index] ?? "";
        if (word === "--") {
            index += 1;
            break;
        }
        if (!word.startsWith("-") || word === "-") {
            break;
        }
        // `a` takes the rest of the cluster as the name, or the next word.
        index += word.indexOf("a") === word.length - 1 ? 2 : 1;
    }
    return commandWords.slice(index);
}

function xargsCommandWords(words: readonly string[]): readonly string[] {
    let index = 0;
    while (index < words.length) {
        const word = words[index] ?? "";
        if (word === "--") {
            index += 1;
            break;
        }
        if (!word.startsWith("-") || word === "-") {
            break;
        }
        index += word.startsWith("--")
            ? XARGS_LONG_OPTIONS_WITH_VALUE.has(word) ? 2 : 1
            : xargsShortOptionWidth(word);
    }
    return words.slice(index);
}

// Reads a cluster such as `-0rn1`: an option with a value takes the rest of
// the word, or the next word when nothing is attached.
function xargsShortOptionWidth(word: string): number {
    for (let index = 1; index < word.length; index += 1) {
        const option = word[index] ?? "";
        if (XARGS_SHORT_OPTIONS_WITH_VALUE.has(option)) {
            return index === word.length - 1 ? 2 : 1;
        }
        if (XARGS_SHORT_OPTIONS_WITH_ATTACHED_VALUE.has(option)) {
            return 1;
        }
    }
    return 1;
}

function findExecScripts(words: readonly string[]): NestedScript[] {
    const scripts: NestedScript[] = [];
    for (let index = 0; index < words.length; index += 1) {
        const option = words[index] ?? "";
        if (!FIND_EXEC_OPTIONS.has(option)) {
            continue;
        }
        let end = index + 1;
        // Only a `+` right after `{}` ends the command.
        while (
            end < words.length
            && words[end] !== ";"
            && !(words[end] === "+" && words[end - 1] === "{}")
        ) {
            end += 1;
        }
        for (const script of scriptOf(
            words.slice(index + 1, end),
            !FIND_PER_MATCH_DIRECTORY_OPTIONS.has(option),
        )) {
            scripts.push(script);
        }
        index = end;
    }
    return scripts;
}

const SHELL_LONG_OPTIONS_WITH_VALUE = new Set(["--rcfile", "--init-file"]);

// Drops only words the shell reads as redirections of `eval` or `exec`
// itself. A quoted `'>x'` is an argument.
function withoutRedirects(command: ScannedCommand, start: number): string[] {
    const kept: string[] = [];
    for (let index = start; index < command.words.length; index += 1) {
        const width = command.redirectWidths[index] ?? 0;
        if (width === 0) {
            kept.push(command.words[index] ?? "");
        } else {
            index += width - 1;
        }
    }
    return kept;
}

// Options may follow `-c`: `bash -c -o pipefail -- 'rm -rf /'` runs the first
// word that is not an option.
export function shellCommandString(
    words: readonly string[],
    executableIndex: number,
): string | undefined {
    const flagIndex = words.findIndex((word, index) =>
        index > executableIndex && /^-[^-]*c/.test(word)
    );
    if (flagIndex === -1) {
        return undefined;
    }
    let index = flagIndex + 1 + shellOptionValues(words[flagIndex] ?? "");
    while (index < words.length) {
        const word = words[index] ?? "";
        if (word === "--" || word === "-" || word === "+") {
            return words[index + 1];
        }
        if (!/^[-+]./.test(word)) {
            return word;
        }
        index += 1 + shellOptionValues(word);
    }
    return undefined;
}

// `-euo pipefail`: each `o` or `O` in a cluster takes the next word.
function shellOptionValues(word: string): number {
    if (word.startsWith("--")) {
        return SHELL_LONG_OPTIONS_WITH_VALUE.has(word) ? 1 : 0;
    }
    return [...word.slice(1)].filter((option) =>
        option === "o" || option === "O"
    ).length;
}
