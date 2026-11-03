export interface ScannedCommand {
    readonly words: string[];
    // True where the word held a quote or backslash, which makes a
    // here-document delimiter quoted.
    readonly quoted: boolean[];
    // True where the word starts with an unquoted `<<` outside arithmetic,
    // `${...}` and `$[...]`.
    readonly startsHereDocument: boolean[];
    // Words taken by a redirection that starts the word: 2 for a lone
    // unquoted `>`, 1 for `>file` or `2>&1`, else 0 (`'>x'` is a word).
    readonly redirectWidths: number[];
    // True for `NAME=value` where the name is unquoted.
    readonly assignments: boolean[];
    // Bodies of the here-documents given to this command.
    readonly hereDocuments: string[];
    // A here-document delimiter holds an opening backtick, `$(`, `${` or `$[`
    // outside single quotes, or a quoted `-` after `<<`: its end cannot be placed.
    readonly unreadableDelimiter: boolean;
    // True when the previous separator was a `)` or a closing backtick. After a
    // case pattern's `)` bash 3.2 reads `time` as a program.
    readonly afterParen: boolean;
}

interface ShellScan {
    readonly commands: ScannedCommand[];
    // Comments outside quotes and here-document bodies, as [start, end).
    readonly comments: Array<readonly [number, number]>;
}

// Bash decides by context the scanner lacks, so a command is scanned under
// every reading that fits it.
export interface ScanReading {
    // A `#` at the start of a word starts a comment.
    readonly comments: boolean;
    // The lines after `<<WORD` are a body that ends at a line `WORD`.
    readonly hereDocuments: boolean;
    // A `(` after `?`, `*`, `+`, `@` or `!` opens an extglob pattern, so a `#`
    // after its `)` stays in the word. Otherwise it is a function name or a
    // negated subshell, and that `#` starts a comment.
    readonly patternGroups?: boolean;
}

export const FULL_READING: ScanReading = {
    comments: true,
    hereDocuments: true,
};

// Each reading differs from the full one only where the command has a `#`
// that starts a comment, or a `<<`.
export function scanReadings(command: string): ScanReading[] {
    const readings: ScanReading[] = [];
    for (
        const hereDocuments of command.includes("<<") ? [true, false] : [true]
    ) {
        readings.push({ comments: true, hereDocuments });
        if (
            command.includes("#")
            && withoutComments(command, { comments: true, hereDocuments })
                !== command
        ) {
            readings.push({ comments: false, hereDocuments });
        }
        if (command.includes("#") && /[?*+@!](?:\\\n)*\(/.test(command)) {
            readings.push({ comments: true, hereDocuments, patternGroups: true });
        }
    }
    return readings;
}

// The descriptor a redirection names: digits, or `{name}` to take a free one.
// Bash 3.2 has no `{name}`, so `{fd}>x` is a word there.
const REDIRECT_FD = String.raw`\d*|\{[A-Za-z_][A-Za-z0-9_]*\}`;
const REDIRECT_BODY = String.raw`(?:<<<|<<-?|<>|<&|>&|>>|>\||<|>)`;
const REDIRECT_OPERATOR = new RegExp(`^(?:${REDIRECT_FD}|&)${REDIRECT_BODY}$`);
const REDIRECT_WORD = new RegExp(`^(?:${REDIRECT_FD}|&)${REDIRECT_BODY}`);
const FD_WORD = new RegExp(`^(?:${REDIRECT_FD})$`);
const HERE_DOCUMENT_DASH = new RegExp(`^(?:${REDIRECT_FD})<<-`);
const HERE_DOCUMENT_OPEN = new RegExp(`^(?:${REDIRECT_FD})<<-?$`);
const HERE_DOCUMENT_WORD = new RegExp(`^(?:${REDIRECT_FD})<<(-?)(.*)$`, "s");
export const HERE_STRING_WORD = new RegExp(`^(?:${REDIRECT_FD})<<<(.*)$`, "s");
// `A=1`, `A+=1` and `A[0]=1` before a command are assignments, not the command.
export const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

// Words taken by a redirection written as `text`: 2 for `>` that waits for
// its target, 1 for `>file` or `2>&1`, 0 for anything else.
function redirectWidthOfText(text: string): number {
    if (REDIRECT_OPERATOR.test(text)) {
        return 2;
    }
    return REDIRECT_WORD.test(text) ? 1 : 0;
}

export function scanSimpleCommands(
    command: string,
    reading: ScanReading = FULL_READING,
): ScannedCommand[] {
    return scanShell(command, reading).commands;
}

// An apostrophe in a comment must not hide a later `$(...)` from scans that
// do not know about comments.
export function withoutComments(
    command: string,
    reading: ScanReading = FULL_READING,
): string {
    let text = "";
    let start = 0;
    const { comments } = scanShell(command, { ...reading, comments: true });
    for (const [commentStart, commentEnd] of comments) {
        text += command.slice(start, commentStart);
        start = commentEnd;
    }
    return text + command.slice(start);
}

// A `#` after `)` or an opening backtick starts a comment, but not after the
// end of `$(...)`, `$((...))` or a backtick pair: `echo $(date)#; rm -rf /`.
const COMMENT_PRECEDERS = new Set([
    " ", "\t", "\n", ";", "&", "|", "(", ")", "`",
]);

// A here-document body is data or a script, never part of the command line,
// so it is read line by line: a stray quote in it must not hide what follows.
function scanShell(command: string, reading: ScanReading): ShellScan {
    const commands: ScannedCommand[] = [];
    const comments: Array<readonly [number, number]> = [];
    let words: string[] = [];
    let quoted: boolean[] = [];
    let startsHereDocument: boolean[] = [];
    let redirectWidths: number[] = [];
    let assignments: boolean[] = [];
    let word = "";
    // `word` with every quoted or escaped character replaced by a NUL.
    let plainWord = "";
    let wordQuoted = false;
    let wordStartsHereDocument = false;
    // True from `<<` until the delimiter word ends.
    let hereDelimiterOpen = false;
    let unreadableDelimiter = false;
    // Index of the last unquoted `<` or `>`, which `&` or `|` may extend. Starts
    // at -2 so that index 0 never counts as right after one.
    let operatorEnd = -2;
    // Inside `((...))` a `<<` is a shift, not a here-document.
    let arithmeticDepth = 0;
    // True while the open `((` began as `$((`.
    let arithmeticExpansion = false;
    // Closers of the open `${`, `$[`, `$(` (as `$)`) and `(`. In `${...}` and
    // `$[...]` a `<<` is text or a shift, and `(` is not a subshell.
    let closers: string[] = [];
    // True after a `$` that can start an expansion. The second `$` of `$$`
    // is the process id, so `$$'...'` is not ANSI-C quoting.
    let dollarOpen: boolean = false;
    let quote: "'" | "\"" | undefined;
    let backtickOuterQuote: "'" | "\"" | undefined;
    // An unclosed `${` or `$((` in a backtick body ends with the backticks.
    let backtickOuterClosers: string[] = [];
    let backtickOuterArithmetic = 0;
    let backtickOuterArithmeticExpansion = false;
    // Index of the last character that ended a `$(...)`, `$((...))` or
    // backtick pair, after which a `#` stays in the word.
    let expansionEnd = -1;
    let inBacktick = false;
    let escaped = false;
    let lineStart = 0;
    let afterParen = false;

    function addToWord(text: string, literal: boolean): void {
        word += text;
        plainWord += literal ? "\0".repeat(text.length) : text;
    }

    // A quoted empty word such as `''` is still a word.
    function finishWord(): void {
        if (word.length > 0 || wordQuoted) {
            words.push(word);
            quoted.push(wordQuoted);
            startsHereDocument.push(wordStartsHereDocument);
            redirectWidths.push(redirectWidthOfText(plainWord));
            assignments.push(ASSIGNMENT_WORD.test(plainWord));
            // `<<\-x` has the delimiter `-x`, but the decoded word reads as `<<-x`.
            if (
                wordStartsHereDocument
                && HERE_DOCUMENT_DASH.test(word)
                && !HERE_DOCUMENT_DASH.test(plainWord)
            ) {
                unreadableDelimiter = true;
            }
            // A lone `<<` leaves the delimiter to the next word.
            hereDelimiterOpen = hereDelimiterOpen
                && !wordQuoted
                && HERE_DOCUMENT_OPEN.test(plainWord);
        }
        word = "";
        plainWord = "";
        wordQuoted = false;
        wordStartsHereDocument = false;
    }

    function finishCommand(): void {
        finishWord();
        hereDelimiterOpen = false;
        if (words.length > 0) {
            commands.push({
                words,
                quoted,
                startsHereDocument,
                redirectWidths,
                assignments,
                hereDocuments: [],
                unreadableDelimiter,
                afterParen,
            });
            unreadableDelimiter = false;
            words = [];
            quoted = [];
            startsHereDocument = [];
            redirectWidths = [];
            assignments = [];
        }
    }

    function insideTextExpansion(): boolean {
        const innermost = closers.at(-1);
        return innermost === "}" || innermost === "]";
    }

    // True when the `(` at `index` continues the word before it: `<(`, `>(`,
    // `a=(`, `a+=(` and, under `patternGroups`, `@(`, so a `#` after its `)`
    // is no comment.
    function joinsWord(index: number): boolean {
        return operatorEnd === index - 1
            || /=$/.test(word)
            || (reading.patternGroups === true && /[?*+@!]$/.test(word));
    }

    function close(closer: string): void {
        if (closers.at(-1) === closer) {
            closers.pop();
        }
    }

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index] ?? "";
        const next = command[index + 1] ?? "";
        const afterDollar: boolean = dollarOpen;
        dollarOpen = false;
        if (
            hereDelimiterOpen
            && !escaped
            && quote !== "'"
            && (
                (character === "`" && !inBacktick)
                || (
                    character === "$"
                    && (next === "(" || next === "{" || next === "[")
                )
            )
        ) {
            unreadableDelimiter = true;
        }
        if (escaped) {
            // A backslash before a newline joins the two lines, so an operator
            // before it still touches the character after it.
            if (character !== "\n") {
                addToWord(character, true);
                wordQuoted = true;
            } else {
                dollarOpen = afterDollar;
                if (operatorEnd === index - 2) {
                    operatorEnd = index;
                }
            }
            escaped = false;
        } else if (
            character === "\\"
            && quote === "\""
            && !["$", "`", "\"", "\\", "\n"].includes(next)
        ) {
            addToWord(character, true);
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
            dollarOpen = afterDollar && next === "\n";
        } else if (character === "`" && quote !== "'") {
            finishCommand();
            afterParen = inBacktick;
            if (inBacktick) {
                quote = backtickOuterQuote;
                backtickOuterQuote = undefined;
                closers = backtickOuterClosers;
                arithmeticDepth = backtickOuterArithmetic;
                arithmeticExpansion = backtickOuterArithmeticExpansion;
                expansionEnd = index;
                inBacktick = false;
            } else {
                backtickOuterQuote = quote;
                quote = undefined;
                backtickOuterClosers = closers;
                closers = [];
                backtickOuterArithmetic = arithmeticDepth;
                backtickOuterArithmeticExpansion = arithmeticExpansion;
                arithmeticDepth = 0;
                inBacktick = true;
            }
        } else if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            } else {
                addToWord(character, true);
            }
        } else if (character === "$" && next === "'" && !afterDollar) {
            const ansiC = readAnsiCString(command, index + 2);
            addToWord(ansiC.text, true);
            wordQuoted = true;
            index = ansiC.end;
        } else if (character === "$" && next === "\"") {
            // `$"..."` is a double-quoted string.
        } else if (character === "'" || character === "\"") {
            quote = character;
            wordQuoted = true;
        } else if (
            character === "#"
            && word.length === 0
            && !wordQuoted
            && reading.comments
            && (
                index === 0
                || (
                    COMMENT_PRECEDERS.has(command[index - 1] ?? "")
                    && expansionEnd !== index - 1
                )
            )
        ) {
            // A comment ends at the newline, or at the end of a backtick body.
            const commentStart = index;
            while (
                index + 1 < command.length
                && command[index + 1] !== "\n"
                && !(inBacktick && command[index + 1] === "`")
            ) {
                index += 1;
            }
            comments.push([commentStart, index + 1]);
        } else if (character === " " || character === "\t") {
            finishWord();
        } else if (character === "&" && operatorEnd === index - 1) {
            addToWord(character, false);
        } else if (
            character === "|"
            && operatorEnd === index - 1
            && command[index - 1] === ">"
        ) {
            addToWord(character, false);
        } else if (character === "&" && next === ">") {
            finishWord();
            addToWord(character, false);
        } else if (";|&()\n".includes(character)) {
            if (character === "(" && (arithmeticDepth > 0 || next === "(")) {
                if (arithmeticDepth === 0) {
                    arithmeticExpansion = afterDollar || joinsWord(index);
                }
                arithmeticDepth += 1;
            } else if (character === ")" && arithmeticDepth > 0) {
                arithmeticDepth -= 1;
                if (arithmeticDepth === 0 && arithmeticExpansion) {
                    expansionEnd = index;
                }
            } else if (
                character === "(" && (afterDollar || !insideTextExpansion())
            ) {
                closers.push(afterDollar || joinsWord(index) ? "$)" : ")");
            } else if (character === ")" && closers.at(-1) === "$)") {
                closers.pop();
                expansionEnd = index;
            } else if (character === ")") {
                close(")");
            }
            finishCommand();
            afterParen = character === ")";
            if (character === "\n" && reading.hereDocuments) {
                index = readHereDocuments(
                    command,
                    index,
                    commands,
                    lineStart,
                    reading,
                );
                lineStart = commands.length;
            }
        } else if (
            character === "<"
            && command[skipLineJoins(command, index + 1)] === "<"
            && operatorEnd !== index - 1
            && arithmeticDepth === 0
            && !insideTextExpansion()
        ) {
            // Bash reads `cat x<<EOF` as `cat x <<EOF`, and `x<<<y` the same way.
            if (wordQuoted || !FD_WORD.test(word)) {
                finishWord();
            }
            wordStartsHereDocument = command[
                skipLineJoins(command, skipLineJoins(command, index + 1) + 1)
            ] !== "<";
            hereDelimiterOpen = hereDelimiterOpen || wordStartsHereDocument;
            addToWord(character, false);
            operatorEnd = index;
        } else {
            if (character === "<" || character === ">") {
                // The delimiter in `<<EOF>out` ends at the `>`.
                if (hereDelimiterOpen && operatorEnd !== index - 1) {
                    finishWord();
                }
                operatorEnd = index;
            }
            if (character === "$") {
                dollarOpen = !afterDollar;
            } else if (afterDollar && character === "{") {
                closers.push("}");
            } else if (
                character === "["
                && (afterDollar || closers.at(-1) === "]")
            ) {
                closers.push("]");
            } else if (character === "}" || character === "]") {
                close(character);
            }
            addToWord(character, false);
        }
    }

    if (escaped) {
        addToWord("\\", true);
    }
    finishCommand();
    return { commands, comments };
}

// The index of the first character at or after `from` that is not part of a
// backslash-newline pair.
function skipLineJoins(command: string, from: number): number {
    let at = from;
    while (command[at] === "\\" && command[at + 1] === "\n") {
        at += 2;
    }
    return at;
}

const ANSI_C_ESCAPES = new Map<string, string>([
    ["a", "\x07"],
    ["b", "\b"],
    ["e", "\x1b"],
    ["E", "\x1b"],
    ["f", "\f"],
    ["n", "\n"],
    ["r", "\r"],
    ["t", "\t"],
    ["v", "\v"],
    ["\\", "\\"],
    ["'", "'"],
    ["\"", "\""],
    ["?", "?"],
]);
const ANSI_C_NUMERIC_ESCAPE =
    /^(?:[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8})/;
// The character after `\c`: printable ASCII except the quote and backslash.
const CONTROL_TARGET = /^[\x20-\x26\x28-\x5b\x5d-\x7e]$/;

// `\'` does not close `$'...'`. Bash drops everything the string holds from
// the first decoded NUL on, so `$'/\0x'` is `/`.
function readAnsiCString(
    command: string,
    start: number,
): { readonly text: string; readonly end: number } {
    let text = "";
    let truncated = false;
    let index = start;
    function append(piece: string): void {
        if (!truncated) {
            text += piece;
        }
    }
    while (index < command.length && command[index] !== "'") {
        const character = command[index] ?? "";
        if (character !== "\\") {
            append(character);
            index += 1;
            continue;
        }
        const escape = command[index + 1] ?? "";
        const simple = ANSI_C_ESCAPES.get(escape);
        const numeric = ANSI_C_NUMERIC_ESCAPE.exec(
            command.slice(index + 1, index + 10),
        )?.[0];
        const controlled = command[index + 2] ?? "";
        if (simple !== undefined) {
            append(simple);
            index += 2;
        } else if (numeric !== undefined) {
            // Octal wraps to a byte: `\400` is NUL and `\457` is `/`.
            const code = /^[0-7]/.test(numeric)
                ? Number.parseInt(numeric, 8) & 0xff
                : Number.parseInt(numeric.slice(1), 16);
            if (code === 0) {
                truncated = true;
            }
            append(code <= 0x10ffff ? String.fromCodePoint(code) : "");
            index += 1 + numeric.length;
        } else if (escape === "c" && CONTROL_TARGET.test(controlled)) {
            // `\c ` and `` \c` `` are NUL, so they truncate like `\c@`.
            const code = controlled === "?"
                ? 0x7f
                : controlled.toUpperCase().charCodeAt(0) & 0x1f;
            if (code === 0) {
                truncated = true;
            }
            append(String.fromCharCode(code));
            index += 3;
        } else {
            append(character + escape);
            index += 2;
        }
    }
    return { text, end: index };
}

interface HereDocumentOperator {
    readonly delimiter: string;
    readonly quoted: boolean;
    readonly stripTabs: boolean;
    readonly owner: ScannedCommand;
}

// Appends each body line as a command. Returns the index of the last
// character read, so the caller resumes after the bodies.
function readHereDocuments(
    command: string,
    newlineIndex: number,
    commands: ScannedCommand[],
    lineStart: number,
    reading: ScanReading,
): number {
    const operators = hereDocumentOperators(commands.slice(lineStart));
    let position = newlineIndex + 1;
    for (const operator of operators) {
        const lines: string[] = [];
        while (position < command.length) {
            const lineEnd = command.indexOf("\n", position);
            const stop = lineEnd === -1 ? command.length : lineEnd;
            const rawLine = command.slice(position, stop);
            position = lineEnd === -1 ? command.length : lineEnd + 1;
            const line = operator.stripTabs
                ? rawLine.replace(/^\t+/, "")
                : rawLine;
            if (line === operator.delimiter) {
                break;
            }
            lines.push(line);
        }
        const body = lines.join("\n");
        // Under an unquoted delimiter the outer shell removes the backslash
        // from `\$`, `` \` `` and `\\` before the inner shell reads the body.
        operator.owner.hereDocuments.push(operator.quoted
            ? body
            : body.replace(/\\([`$\\\n])/g, (_match, escaped: string) =>
                escaped === "\n" ? "" : escaped
            ));
        for (const line of lines) {
            for (const scanned of scanSimpleCommands(line, reading)) {
                commands.push(scanned);
            }
        }
    }
    return position - 1;
}

function hereDocumentOperators(
    lineCommands: readonly ScannedCommand[],
): HereDocumentOperator[] {
    const operators: HereDocumentOperator[] = [];
    for (const owner of lineCommands) {
        for (let index = 0; index < owner.words.length; index += 1) {
            const match = owner.startsHereDocument[index] === true
                ? HERE_DOCUMENT_WORD.exec(owner.words[index] ?? "")
                : null;
            if (match === null) {
                continue;
            }
            const attached = match[2] ?? "";
            // `<<''` leaves the operator alone in a quoted word.
            const delimiterIndex = attached === "" && !owner.quoted[index]
                ? index + 1
                : index;
            const delimiter = delimiterIndex === index
                ? attached
                : owner.words[delimiterIndex];
            if (delimiter === undefined) {
                continue;
            }
            operators.push({
                delimiter,
                quoted: owner.quoted[delimiterIndex] === true,
                stripTabs: match[1] === "-",
                owner,
            });
            index = delimiterIndex;
        }
    }
    return operators;
}
