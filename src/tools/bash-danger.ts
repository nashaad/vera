import {
    ASSIGNMENT_WORD,
    FULL_READING,
    HERE_STRING_WORD,
    scanSimpleCommands,
    withoutComments,
    type ScanReading,
    type ScannedCommand,
} from "./bash-scan.ts";
import {
    quoteWords,
    shellCommandString,
    wrappedCommandScripts,
    type NestedScript,
} from "./bash-wrappers.ts";

const SHELL_CONTROL_PREFIXES = new Set([
    "!",
    "{",
    "coproc",
    "do",
    "elif",
    "else",
    "function",
    "if",
    "then",
    "time",
    "until",
    "while",
]);

// For parser words. The command after `env -S` is inside the split string,
// so no word here is the executable.
export function simpleCommandExecutableIndex(
    words: readonly string[],
): number {
    const { executableIndex, envSplit } = commandPrefix(words, undefined, false);
    return envSplit === undefined ? executableIndex : words.length;
}

// For a command from scanSimpleCommands, whose words keep redirects. A quoted
// reserved word is skipped too, which reads more commands.
export function scannedExecutableIndex(command: ScannedCommand): number {
    return commandPrefix(command.words, command, false).executableIndex;
}

// The index of a `cd` that changes this shell's directory, else undefined.
// `env cd` and `/usr/bin/cd` run a program that changes only its own.
export function shellCdIndex(
    words: readonly string[],
    scanned?: ScannedCommand,
    timeAfterControlWord = true,
): number | undefined {
    const prefix = commandPrefix(words, scanned, true, timeAfterControlWord);
    return prefix.runsInShell && words[prefix.executableIndex] === "cd"
        ? prefix.executableIndex
        : undefined;
}

interface CommandPrefix {
    readonly executableIndex: number;
    // The first `env -S`. Later ones sit inside the words it re-reads.
    readonly envSplit: EnvSplit | undefined;
    // False after `env`, after `command -v` (a lookup) and after an option
    // that `command` or `builtin` rejects.
    readonly runsInShell: boolean;
}

interface EnvSplit {
    readonly value: string;
    readonly restIndex: number;
}

// With `scanned`, quoting is known: a quoted `'>x'` or `'A=1'` is the command
// name. With `exact`, so is `'time'`, and `time` or `!` counts only first.
function commandPrefix(
    words: readonly string[],
    scanned: ScannedCommand | undefined,
    exact: boolean,
    timeAfterControlWord = true,
): CommandPrefix {
    let envSplit: EnvSplit | undefined;
    let runsInShell = true;
    let afterEnv = false;
    let atCommandStart = true;
    let index = 0;
    while (index < words.length) {
        if (exact && atCommandStart) {
            const skipped = skipControlWords(
                words,
                scanned,
                exact,
                index,
                timeAfterControlWord,
            );
            index = skipped.index;
            runsInShell = runsInShell && !skipped.detached;
        }
        atCommandStart = false;
        index = skipAssignmentsAndRedirects(words, scanned, afterEnv, index);
        // A reserved word can be followed by an assignment or a redirect, and
        // that by another reserved word.
        let before = -1;
        while (!exact && before !== index) {
            before = index;
            index = skipAssignmentsAndRedirects(
                words,
                scanned,
                afterEnv,
                skipControlWords(words, scanned, exact, index, true).index,
            );
        }

        const executable = words[index]?.split("/").at(-1);
        if (executable === "env") {
            runsInShell = false;
            afterEnv = true;
            index += 1;
            while (words[index]?.startsWith("-")) {
                const option = envOption(words, index);
                if (option.split !== undefined && envSplit === undefined) {
                    envSplit = {
                        value: option.split,
                        restIndex: index + option.width,
                    };
                }
                index += option.width;
            }
            continue;
        }
        if (executable === "command" || executable === "builtin") {
            index += 1;
            const options = exact
                ? exactWrapperOptions(words, index, executable)
                : looseWrapperOptions(words, index);
            index = options.next;
            runsInShell = runsInShell && options.runsCommand;
            continue;
        }
        break;
    }
    return { executableIndex: index, envSplit, runsInShell };
}

// Bash 3.2 reads `time` as reserved only at the start of a command and after
// these words. After `if`, `!`, `time` or a case pattern's `)` it runs a
// program instead.
const WORDS_BEFORE_TIME = new Set(["{", "do", "then", "else"]);

// After `coproc NAME` these start the command that the coprocess runs.
const WORDS_AFTER_COPROC_NAME = new Set(["{", "if", "until", "while"]);

interface SkippedControlWords {
    readonly index: number;
    // A coprocess runs in a subshell and a function body runs later, so a
    // `cd` in either changes no directory here.
    readonly detached: boolean;
}

function skipControlWords(
    words: readonly string[],
    scanned: ScannedCommand | undefined,
    exact: boolean,
    start: number,
    timeAfterControlWord: boolean,
): SkippedControlWords {
    function isQuoted(at: number): boolean {
        return exact && scanned?.quoted[at] === true;
    }
    function isControlWord(at: number): boolean {
        return SHELL_CONTROL_PREFIXES.has(words[at] ?? "") && !isQuoted(at);
    }
    function isReserved(at: number): boolean {
        return timeAfterControlWord
            || words[at] !== "time"
            || (at === start && scanned?.afterParen !== true)
            || (at > start && WORDS_BEFORE_TIME.has(words[at - 1] ?? ""));
    }
    let index = start;
    let detached = false;
    while (isControlWord(index) && isReserved(index)) {
        const word = words[index];
        index += 1;
        if (word === "time") {
            // Bash 3.2 reads `time --` as a program named `--`, and bash in
            // posix mode does not reserve `time` before `-p`.
            const readsOptions = timeAfterControlWord;
            if (readsOptions && words[index] === "-p" && !isQuoted(index)) {
                index += 1;
            }
            if (readsOptions && words[index] === "--" && !isQuoted(index)) {
                index += 1;
            }
        } else if (word === "function") {
            detached = true;
            index = Math.min(index + 1, words.length);
        } else if (word === "coproc") {
            detached = true;
            if (
                isControlWord(index + 1)
                && WORDS_AFTER_COPROC_NAME.has(words[index + 1] ?? "")
            ) {
                index += 1;
            }
        }
    }
    return { index, detached };
}

interface WrapperOptions {
    readonly next: number;
    // False when the options make `command` look a name up, or make `command`
    // or `builtin` fail, so no command runs in this shell.
    readonly runsCommand: boolean;
}

// Reads more commands: every word that starts with `-` is skipped.
function looseWrapperOptions(
    words: readonly string[],
    start: number,
): WrapperOptions {
    let index = start;
    let runsCommand = true;
    while (words[index]?.startsWith("-")) {
        if (/^-[^-]*[vV]/.test(words[index] ?? "")) {
            runsCommand = false;
        }
        index += 1;
    }
    return { next: index, runsCommand };
}

// `builtin` takes only `--`. `command` takes `-p`, `-v`, `-V` and `--`, and
// fails on any other option, as in `builtin -p cd` or `command -x cd`.
function exactWrapperOptions(
    words: readonly string[],
    start: number,
    wrapper: string,
): WrapperOptions {
    let index = start;
    let runsCommand = true;
    while (index < words.length) {
        const word = words[index] ?? "";
        if (word === "--") {
            index += 1;
            break;
        }
        if (!word.startsWith("-") || word === "-") {
            break;
        }
        if (wrapper === "command" && /^-[pvV]+$/.test(word)) {
            runsCommand = runsCommand && !/[vV]/.test(word);
        } else {
            runsCommand = false;
        }
        index += 1;
    }
    return { next: index, runsCommand };
}

// `FOO=1 2>/dev/null rm` runs rm. Env takes any word with an `=` as an
// assignment, quoted or not.
function skipAssignmentsAndRedirects(
    words: readonly string[],
    scanned: ScannedCommand | undefined,
    afterEnv: boolean,
    start: number,
): number {
    let index = start;
    while (index < words.length) {
        let width = 0;
        if (afterEnv && words[index]?.includes("=") === true) {
            width = 1;
        } else if (scanned === undefined) {
            width = isEnvironmentAssignment(words[index]) ? 1 : 0;
        } else if (scanned.assignments[index] === true) {
            width = 1;
        } else {
            width = scanned.redirectWidths[index] ?? 0;
        }
        if (width === 0) {
            break;
        }
        index += width;
    }
    return index;
}

// `env -S 'rm -rf /' x` runs `env rm -rf / x`. Env and the shell split the
// value differently, so the script is built for both readings.
function envSplitScripts(
    words: readonly string[],
    split: EnvSplit,
): string[] {
    const rest = quoteWords(words.slice(split.restIndex));
    return [
        `env ${split.value} ${rest}`,
        `env ${quoteWords(splitEnvString(split.value))} ${rest}`,
    ];
}

const ENV_CONTROL_ESCAPES = new Map<string, string>([
    ["f", "\f"],
    ["n", "\n"],
    ["r", "\r"],
    ["t", "\t"],
    ["v", "\v"],
]);

// The character an escape stands for inside `quote`, or undefined when the
// backslash is kept as text. `\_` outside quotes is handled by the caller.
function envEscape(
    escape: string,
    quote: string | undefined,
): string | undefined {
    if (escape === "\\" || escape === "'") {
        return escape;
    }
    if (quote === "'") {
        return undefined;
    }
    if (escape === "_") {
        return " ";
    }
    if (escape === "\"" || escape === "$" || escape === "#") {
        return escape;
    }
    return ENV_CONTROL_ESCAPES.get(escape);
}

// Env's own splitting: whitespace and an unquoted `\_` separate words, `\c`
// ends the string. A `#` is read as text, which reads more than env does.
function splitEnvString(value: string): string[] {
    const args: string[] = [];
    let arg = "";
    let inArg = false;
    let quote: "'" | "\"" | undefined;

    function finishArg(): void {
        if (inArg) {
            args.push(arg);
        }
        arg = "";
        inArg = false;
    }

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index] ?? "";
        if (character === quote) {
            quote = undefined;
        } else if (
            quote === undefined && (character === "'" || character === "\"")
        ) {
            quote = character;
            inArg = true;
        } else if (character === "\\") {
            const escape = value[index + 1] ?? "";
            if (escape === "c" && quote !== "'") {
                break;
            }
            if (escape === "_" && quote === undefined) {
                finishArg();
                index += 1;
                continue;
            }
            const literal = envEscape(escape, quote);
            arg += literal ?? character;
            index += literal === undefined ? 0 : 1;
            inArg = true;
        } else if (quote === undefined && /\s/.test(character)) {
            finishArg();
        } else {
            arg += character;
            inArg = true;
        }
    }
    finishArg();
    return args;
}

interface EnvOption {
    readonly width: number;
    readonly split: string | undefined;
}

const ENV_SHORT_OPTIONS_WITH_VALUE = new Set(["C", "P", "S", "u"]);
const ENV_LONG_OPTIONS_WITH_VALUE = new Set([
    "--chdir",
    "--split-string",
    "--unset",
]);

// In a cluster such as `-iS'rm -rf /'`, an option that takes a value takes
// the rest of the word, or the next word when nothing is attached.
function envOption(words: readonly string[], index: number): EnvOption {
    const word = words[index] ?? "";
    if (word.startsWith("--")) {
        const equals = word.indexOf("=");
        const name = equals === -1 ? word : word.slice(0, equals);
        const separate = equals === -1
            && ENV_LONG_OPTIONS_WITH_VALUE.has(name);
        const value = separate ? words[index + 1] : word.slice(equals + 1);
        return {
            width: separate ? 2 : 1,
            split: name === "--split-string" ? value : undefined,
        };
    }
    for (let at = 1; at < word.length; at += 1) {
        const option = word[at] ?? "";
        if (ENV_SHORT_OPTIONS_WITH_VALUE.has(option)) {
            const attached = word.slice(at + 1);
            const value = attached === "" ? words[index + 1] : attached;
            return {
                width: attached === "" ? 2 : 1,
                split: option === "S" ? value : undefined,
            };
        }
    }
    return { width: 1, split: undefined };
}

function isEnvironmentAssignment(word: string | undefined): boolean {
    return word !== undefined && ASSIGNMENT_WORD.test(word);
}

export interface NestedShellCommand extends NestedScript {
    // Index into the scanned commands of the command that runs the script.
    // Undefined for substitutions, which are found in the text.
    readonly commandIndex: number | undefined;
}

// Under a reading with comments off a `#` is text, so a script after it is
// found even where the scanner would have taken the `#` for a comment.
export function nestedShellCommands(
    command: string,
    scanned = scanSimpleCommands(command),
    reading: ScanReading = FULL_READING,
): NestedShellCommand[] {
    const text = reading.comments && command.includes("#")
        ? withoutComments(command, reading)
        : command;
    const scripts: NestedShellCommand[] = [
        ...dollarCommandSubstitutions(text),
        ...nestedBacktickSubstitutions(text),
    ].map((script) => ({
        script,
        directoryKnown: true,
        commandIndex: undefined,
    }));

    scanned.forEach((scannedCommand, commandIndex) => {
        function add(script: string, directoryKnown = true): void {
            scripts.push({ script, directoryKnown, commandIndex });
        }

        const { words, hereDocuments } = scannedCommand;
        const { executableIndex, envSplit } = commandPrefix(
            words,
            scannedCommand,
            false,
        );
        if (envSplit !== undefined) {
            envSplitScripts(words, envSplit).forEach((script) => add(script));
        }

        const executable = words[executableIndex]?.split("/").at(-1) ?? "";
        wrappedCommandScripts(executable, scannedCommand, executableIndex)
            .forEach(({ script, directoryKnown }) => add(script, directoryKnown));

        // Whatever command gets the text, a shell may be what reads it:
        // `{ bash; } <<EOF`, `eval eval bash <<< ...` and `cat <<EOF | bash`.
        [...hereDocuments, ...hereStrings(scannedCommand)].forEach(
            (script) => add(script),
        );

        const shellCommand = SHELL_NAMES.has(executable)
            ? shellCommandString(words, executableIndex)
            : undefined;
        if (shellCommand !== undefined) {
            add(shellCommand);
        }
    });
    return scripts;
}

const SHELL_NAMES = new Set(["bash", "sh", "zsh"]);

function hereStrings(command: ScannedCommand): string[] {
    const strings: string[] = [];
    const { words, redirectWidths } = command;
    for (let index = 0; index < words.length; index += 1) {
        if ((redirectWidths[index] ?? 0) === 0) {
            continue;
        }
        const match = HERE_STRING_WORD.exec(words[index] ?? "");
        if (match === null) {
            continue;
        }
        const attached = match[1] ?? "";
        const text = attached === "" ? words[index + 1] : attached;
        if (text !== undefined) {
            strings.push(text);
        }
        if (attached === "") {
            index += 1;
        }
    }
    return strings;
}

// The tokenizer misses the inner substitution in `` `echo \`rm -rf /\`` ``,
// so a body that holds escaped backticks is unescaped and checked again.
function nestedBacktickSubstitutions(command: string): string[] {
    const bodies: string[] = [];
    let quote: "'" | "\"" | undefined;
    let escaped = false;

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (escaped) {
            escaped = false;
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
        } else if (character === "'" && quote !== "\"") {
            quote = quote === "'" ? undefined : "'";
        } else if (character === "\"" && quote !== "'") {
            quote = quote === "\"" ? undefined : "\"";
        } else if (character === "`" && quote !== "'") {
            const closingIndex = backtickEnd(command, index + 1);
            if (closingIndex === undefined) {
                break;
            }
            const body = command.slice(index + 1, closingIndex);
            if (body.includes("\\`")) {
                bodies.push(body.replace(/\\([`$\\])/g, "$1"));
            }
            index = closingIndex;
        }
    }
    return bodies;
}

function backtickEnd(command: string, start: number): number | undefined {
    for (let index = start; index < command.length; index += 1) {
        if (command[index] === "\\") {
            index += 1;
        } else if (command[index] === "`") {
            return index;
        }
    }
    return undefined;
}

function dollarCommandSubstitutions(command: string): string[] {
    const substitutions: string[] = [];
    let quote: "'" | "\"" | undefined;
    let escaped = false;

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }
        if (character === "'" && quote !== "\"") {
            quote = quote === "'" ? undefined : "'";
            continue;
        }
        if (character === "\"" && quote !== "'") {
            quote = quote === "\"" ? undefined : "\"";
            continue;
        }
        if (
            character !== "$"
            || command[index + 1] !== "("
            || quote === "'"
        ) {
            continue;
        }

        if (isArithmeticExpansion(command, index)) {
            // Scan the expression for real substitutions inside it.
            index += 2;
            continue;
        }

        const closingIndex = commandSubstitutionEnd(command, index + 2);
        if (closingIndex !== undefined) {
            substitutions.push(command.slice(index + 2, closingIndex));
            index = closingIndex;
        }
    }
    return substitutions;
}

// `$((1+1))` is arithmetic. `$((cd /); ls)` is a substitution that starts
// with a subshell, so the group opened by the second `(` must close at `))`.
function isArithmeticExpansion(command: string, dollarIndex: number): boolean {
    if (command[dollarIndex + 2] !== "(") {
        return false;
    }
    const groupEnd = commandSubstitutionEnd(command, dollarIndex + 3);
    return groupEnd !== undefined && command[groupEnd + 1] === ")";
}

function commandSubstitutionEnd(
    command: string,
    start: number,
): number | undefined {
    let depth = 1;
    let quote: "'" | "\"" | undefined;
    let escaped = false;

    for (let index = start; index < command.length; index += 1) {
        const character = command[index];
        if (escaped) {
            escaped = false;
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
        } else if (character === "'" && quote !== "\"") {
            quote = quote === "'" ? undefined : "'";
        } else if (character === "\"" && quote !== "'") {
            quote = quote === "\"" ? undefined : "\"";
        } else if (quote === undefined && character === "(") {
            depth += 1;
        } else if (quote === undefined && character === ")") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return undefined;
}
