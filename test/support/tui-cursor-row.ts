/**
 * The row under the cursor, read the way the eye reads it: the highlight bar
 * is a background colour, so it is the one line painted in a colour no other
 * line on the card is painted in.
 */
export function cursorRow(colored: string): string {
    const lines = colored.split("\n").map((line) => ({
        backgrounds: new Set(
            Array.from(line.matchAll(/\[[\d;]*?48;2;(\d+;\d+;\d+)/g))
                .map((match) => match[1] ?? ""),
        ),
        text: line.replace(/\[[\d;:]*m/g, "").trimEnd(),
    }));
    const seen = new Map<string, number>();
    for (const line of lines) {
        for (const background of line.backgrounds) {
            seen.set(background, (seen.get(background) ?? 0) + 1);
        }
    }
    const unique = lines.find((line) =>
        [...line.backgrounds].some((background) => seen.get(background) === 1)
    );
    return unique?.text ?? "";
}

