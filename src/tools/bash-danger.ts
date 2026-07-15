export function containsRecursiveForceRm(command: string): boolean {
    return tokenizeSimpleCommands(command).some((words) =>
        isRecursiveForceRm(words)
    );
}

function isRecursiveForceRm(words: readonly string[]): boolean {
    const executableIndex = findExecutableIndex(words);
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

function findExecutableIndex(words: readonly string[]): number {
    let index = 0;
    while (isEnvironmentAssignment(words[index])) {
        index += 1;
    }

    if (words[index] === "command") {
        index += 1;
    }

    return index;
}

function isEnvironmentAssignment(word: string | undefined): boolean {
    return word !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function tokenizeSimpleCommands(command: string): string[][] {
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
