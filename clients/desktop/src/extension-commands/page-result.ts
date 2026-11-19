export interface PageRectangle {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface PageDetails {
    readonly tag: string;
    readonly selector: string;
    readonly text: string;
    readonly styles: string;
    readonly html: string;
    readonly siblings: string;
}

export interface PageResult {
    readonly rect: PageRectangle;
    readonly text: string;
    readonly details?: PageDetails;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePageResult(value: unknown): PageResult | undefined {
    if (!record(value) || !record(value.rect) || typeof value.text !== "string" || value.text.length > 16384) return undefined;
    const rect = value.rect;
    if (![rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 10000)) return undefined;
    if ((rect.width as number) < 1 || (rect.height as number) < 1) return undefined;
    let details: PageDetails | undefined;
    if (value.details !== undefined) {
        if (!record(value.details)) return undefined;
        const caps = { tag: 256, selector: 4096, text: 500, styles: 4096, html: 2000, siblings: 4096 };
        const fields: Record<string, string> = {};
        for (const [key, cap] of Object.entries(caps)) {
            const part = value.details[key];
            if (typeof part !== "string" || part.length > cap) return undefined;
            fields[key] = part;
        }
        details = fields as unknown as PageDetails;
    }
    return { rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number }, text: value.text, ...(details === undefined ? {} : { details }) };
}
