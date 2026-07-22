const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

export function pastedImagePath(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.includes("\n")) return undefined;
    const quote = trimmed[0];
    const unquoted = (quote === "\"" || quote === "'")
            && trimmed.at(-1) === quote
        ? trimmed.slice(1, -1)
        : trimmed;
    const path = unquoted.replace(/\\ /g, " ");
    return path.startsWith("/") && IMAGE_EXTENSION.test(path)
        ? path
        : undefined;
}
