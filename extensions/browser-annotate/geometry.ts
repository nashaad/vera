export interface Point {
    readonly x: number;
    readonly y: number;
}

export interface Drawing {
    readonly kind: "pen" | "line" | "arrow" | "rectangle" | "ellipse" | "step" | "text";
    readonly points: readonly Point[];
    readonly color: string;
    readonly width: number;
    readonly label?: string;
    readonly number?: number;
}

function segmentDistance(point: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

export function hitDrawing(item: Drawing, point: Point, textWidth: (item: Drawing) => number): boolean {
    const first = item.points[0];
    if (first === undefined) return false;
    const last = item.points[item.points.length - 1] ?? first;
    const tolerance = Math.max(5, item.width / 2 + 3);
    if (item.kind === "text") {
        const size = Math.max(12, item.width * 5);
        return point.x >= first.x - tolerance && point.x <= first.x + textWidth(item) + tolerance && point.y >= first.y - size - tolerance && point.y <= first.y + tolerance;
    }
    if (item.kind === "step") return Math.hypot(point.x - first.x, point.y - first.y) <= 12 + tolerance;
    if (item.kind === "pen") {
        if (item.points.length === 1) return segmentDistance(point, first, first) <= tolerance;
        for (let i = 1; i < item.points.length; i++) {
            if (segmentDistance(point, item.points[i - 1]!, item.points[i]!) <= tolerance) return true;
        }
        return false;
    }
    if (item.kind === "line" || item.kind === "arrow") {
        if (segmentDistance(point, first, last) <= tolerance) return true;
        if (item.kind === "arrow") {
            const angle = Math.atan2(last.y - first.y, last.x - first.x);
            for (const delta of [-Math.PI / 6, Math.PI / 6]) {
                const tip = { x: last.x - 12 * Math.cos(angle + delta), y: last.y - 12 * Math.sin(angle + delta) };
                if (segmentDistance(point, last, tip) <= tolerance) return true;
            }
        }
        return false;
    }
    const left = Math.min(first.x, last.x), right = Math.max(first.x, last.x);
    const top = Math.min(first.y, last.y), bottom = Math.max(first.y, last.y);
    if (item.kind === "rectangle") {
        return segmentDistance(point, { x: left, y: top }, { x: right, y: top }) <= tolerance
            || segmentDistance(point, { x: right, y: top }, { x: right, y: bottom }) <= tolerance
            || segmentDistance(point, { x: right, y: bottom }, { x: left, y: bottom }) <= tolerance
            || segmentDistance(point, { x: left, y: bottom }, { x: left, y: top }) <= tolerance;
    }
    if (point.x < left - tolerance || point.x > right + tolerance || point.y < top - tolerance || point.y > bottom + tolerance) return false;
    const rx = (right - left) / 2, ry = (bottom - top) / 2;
    if (rx === 0 || ry === 0) return segmentDistance(point, first, last) <= tolerance;
    const x = point.x - (left + right) / 2, y = point.y - (top + bottom) / 2;
    const radius = Math.hypot(x / rx, y / ry);
    return Math.abs(radius - 1) * Math.min(rx, ry) <= tolerance;
}

export function translateDrawing(item: Drawing, dx: number, dy: number): Drawing {
    return { ...item, points: item.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
}
