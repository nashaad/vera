const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

function splitPastedPaths(value: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: string | undefined;

    for (let index = 0; index < value.length; index += 1) {
        const char = value[index]!;
        if (char === "\\" && index + 1 < value.length) {
            index += 1;
            current += value[index];
            continue;
        }
        if (quote !== undefined) {
            if (char === quote) quote = undefined;
            else current += char;
            continue;
        }
        if (char === "\"" || char === "'") {
            quote = char;
            continue;
        }
        if (char === " ") {
            if (current.length > 0) parts.push(current);
            current = "";
            continue;
        }
        current += char;
    }

    if (current.length > 0) parts.push(current);
    return parts;
}

export function pastedImagePaths(value: string): string[] {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.includes("\n")) return [];
    const paths = splitPastedPaths(trimmed);
    const images = paths.filter((path) =>
        path.startsWith("/") && IMAGE_EXTENSION.test(path)
    );
    return images.length === paths.length ? images : [];
}
