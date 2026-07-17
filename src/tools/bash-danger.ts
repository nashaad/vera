export function containsRecursiveForceRm(command: string): boolean {
    return containsRecursiveForceRmAtDepth(command, 0);
}

const MAX_NESTED_SHELL_DEPTH = 4;
const SHELL_CONTROL_PREFIXES = new Set([
    "!",
    "{",
    "do",
    "elif",
    "else",
    "if",
    "then",
    "time",
    "until",
    "while",
]);

function containsRecursiveForceRmAtDepth(
    command: string,
    depth: number,
): boolean {
    const commands = tokenizeSimpleCommands(command);
    if (commands.some((words) => isRecursiveForceRm(words))) {
        return true;
    }
    if (depth >= MAX_NESTED_SHELL_DEPTH) {
        return false;
    }
    return nestedShellCommands(command, commands).some((nested) =>
        containsRecursiveForceRmAtDepth(nested, depth + 1)
    );
}

function isRecursiveForceRm(words: readonly string[]): boolean {
    const executableIndex = simpleCommandExecutableIndex(words);
    const executable = words[executableIndex]?.split("/").at(-1);
    if (executable !== "rm") {
        return false;
    }

    let recursive = false;
    let force = false;

    for (const word of words.slice(executableIndex + 1)) {
        if (word === "--") {
            break;
        }
        if (word === "--recursive") {
            recursive = true;
        } else if (word === "--force") {
            force = true;
        } else if (word.startsWith("-") && !word.startsWith("--")) {
            if (word.includes("r") || word.includes("R")) {
                recursive = true;
            }
            if (word.includes("f")) {
                force = true;
            }
        }
    }

    return recursive && force;
}

export function simpleCommandExecutableIndex(
    words: readonly string[],
): number {
    let index = 0;
    while (index < words.length) {
        while (isEnvironmentAssignment(words[index])) {
            index += 1;
        }

        while (SHELL_CONTROL_PREFIXES.has(words[index] ?? "")) {
            index += 1;
        }

        const executable = words[index]?.split("/").at(-1);
        if (executable === "env") {
            index += 1;
            while (words[index]?.startsWith("-")) {
                const option = words[index];
                if (option === undefined) {
                    break;
                }
                index += envOptionTakesValue(option) ? 2 : 1;
            }
            continue;
        }
        if (executable === "command") {
            index += 1;
            while (words[index]?.startsWith("-")) {
                index += 1;
            }
            continue;
        }
        break;
    }
    return index;
}

function envOptionTakesValue(option: string): boolean {
    return option === "-u"
        || option === "--unset"
        || option === "-C"
        || option === "--chdir"
        || option === "-S"
        || option === "--split-string";
}

function isEnvironmentAssignment(word: string | undefined): boolean {
    return word !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

export function tokenizeSimpleCommands(command: string): string[][] {
    const commands: string[][] = [];
    let words: string[] = [];
    let word = "";
    let quote: "'" | "\"" | undefined;
    let backtickOuterQuote: "'" | "\"" | undefined;
    let inBacktick = false;
    let escaped = false;

    function finishWord(): void {
        if (word.length > 0) {
            words.push(word);
            word = "";
        }
    }

    function finishCommand(): void {
        finishWord();
        if (words.length > 0) {
            commands.push(words);
            words = [];
        }
    }

    for (const character of command) {
        if (escaped) {
            word += character;
            escaped = false;
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
        } else if (character === "`" && quote !== "'") {
            finishCommand();
            if (inBacktick) {
                quote = backtickOuterQuote;
                backtickOuterQuote = undefined;
                inBacktick = false;
            } else {
                backtickOuterQuote = quote;
                quote = undefined;
                inBacktick = true;
            }
        } else if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            } else {
                word += character;
            }
        } else if (character === "'" || character === "\"") {
            quote = character;
        } else if (character === " " || character === "\t") {
            finishWord();
        } else if (";|&()\n".includes(character)) {
            finishCommand();
        } else {
            word += character;
        }
    }

    if (escaped) {
        word += "\\";
    }
    finishCommand();
    return commands;
}

export function nestedShellCommands(
    command: string,
    commands = tokenizeSimpleCommands(command),
): string[] {
    const nested = dollarCommandSubstitutions(command);
    for (const words of commands) {
        const executableIndex = simpleCommandExecutableIndex(words);
        const executable = words[executableIndex]?.split("/").at(-1);
        if (
            executable !== "bash"
            && executable !== "sh"
            && executable !== "zsh"
        ) {
            continue;
        }

        const commandFlagIndex = words.findIndex((word, index) =>
            index > executableIndex
            && /^-[^-]*c/.test(word)
        );
        const shellCommand = words[commandFlagIndex + 1];
        if (commandFlagIndex !== -1 && shellCommand !== undefined) {
            nested.push(shellCommand);
        }
    }
    return nested;
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

        const closingIndex = commandSubstitutionEnd(command, index + 2);
        if (closingIndex !== undefined) {
            substitutions.push(command.slice(index + 2, closingIndex));
            index = closingIndex;
        }
    }
    return substitutions;
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
