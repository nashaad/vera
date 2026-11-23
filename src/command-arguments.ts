export function tokenizeCommandArguments(
    text: string,
    label: string,
): { readonly words: readonly string[] } | { readonly error: string } {
    const words: string[] = [];
    let current = "";
    let quoted: "'" | '"' | undefined;
    let escaped = false;
    let started = false;
    for (const character of text) {
        if (escaped) {
            current += character;
            escaped = false;
            started = true;
            continue;
        }
        if (character === "\\" && quoted !== "'") {
            escaped = true;
            started = true;
            continue;
        }
        if (quoted !== undefined) {
            if (character === quoted) {
                quoted = undefined;
            } else {
                current += character;
            }
            started = true;
            continue;
        }
        if (character === "'" || character === '"') {
            quoted = character;
            started = true;
        } else if (/\s/.test(character)) {
            if (started) {
                words.push(current);
                current = "";
                started = false;
            }
        } else {
            current += character;
            started = true;
        }
    }
    if (escaped) current += "\\";
    if (quoted !== undefined) {
        return { error: `Unclosed quote in ${label}` };
    }
    if (started) words.push(current);
    return { words };
}
