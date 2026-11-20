import type {
    UsageModelRow,
    UsageTimelineBucket,
    UsageTimelinePoint,
} from "../../src/annex/usage-report.ts";

export const CHART_HEIGHT = 200;
export const CHART_PAD_LEFT = 44;
export const CHART_PAD_RIGHT = 2;
export const CHART_PAD_TOP = 8;
export const CHART_PAD_BOTTOM = 24;

export interface ChartScale {
    readonly width: number;
    readonly padLeft: number;
    readonly padRight: number;
    readonly padTop: number;
    readonly padBottom: number;
    readonly plotWidth: number;
    readonly plotHeight: number;
    readonly max: number;
    readonly x: (index: number) => number;
    readonly y: (value: number) => number;
}

/** Rounds an axis peak up to 1, 2, 4, 5 or 10 times a power of ten. */
export function niceMax(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0.01;
    const exponent = 10 ** Math.floor(Math.log10(value));
    const fraction = value / exponent;
    const step = fraction <= 1
        ? 1
        : fraction <= 2
        ? 2
        : fraction <= 4
        ? 4
        : fraction <= 5
        ? 5
        : 10;
    return Number((step * exponent).toPrecision(12));
}

export function chartScale(
    width: number,
    count: number,
    peak: number,
    height = CHART_HEIGHT,
): ChartScale {
    const plotWidth = Math.max(width - CHART_PAD_LEFT - CHART_PAD_RIGHT, 0);
    const plotHeight = Math.max(height - CHART_PAD_TOP - CHART_PAD_BOTTOM, 0);
    const max = niceMax(peak);
    const x = (index: number): number => {
        if (count <= 1) return CHART_PAD_LEFT + plotWidth / 2;
        return CHART_PAD_LEFT + (plotWidth * index) / (count - 1);
    };
    const y = (value: number): number =>
        CHART_PAD_TOP + plotHeight - (value / max) * plotHeight;
    return {
        width,
        padLeft: CHART_PAD_LEFT,
        padRight: CHART_PAD_RIGHT,
        padTop: CHART_PAD_TOP,
        padBottom: CHART_PAD_BOTTOM,
        plotWidth,
        plotHeight,
        max,
        x,
        y,
    };
}

/** First, middle and last bucket, without repeating a label. */
export function labelIndices(count: number): number[] {
    if (count <= 0) return [];
    const middle = Math.floor((count - 1) / 2);
    return [...new Set([0, middle, count - 1])];
}

/** Snaps a 0..1 pointer ratio to the nearest bucket. */
export function nearestIndex(count: number, ratio: number): number {
    if (count <= 1) return 0;
    const clamped = Math.min(Math.max(ratio, 0), 1);
    return Math.min(Math.max(Math.round(clamped * (count - 1)), 0), count - 1);
}

export function axisTicks(max: number): readonly number[] {
    return [0, max / 2, max];
}

/** Axis labels stay short: $0, $2.5, $10. Tooltips use the full money formatter. */
export function axisMoney(value: number): string {
    if (value === 0) return "$0";
    const magnitude = Math.abs(value);
    if (magnitude >= 1) {
        return `$${Number.isInteger(value) ? value : value.toFixed(1)}`;
    }
    // Keep one digit beyond the leading decimal so neighbouring ticks differ.
    const decimals = Math.min(
        10,
        Math.max(2, Math.ceil(-Math.log10(magnitude)) + 1),
    );
    return `$${value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export type ChartTone = "m0" | "m1" | "m2" | "rest";

export interface ChartSeries {
    readonly key: string;
    readonly row: UsageModelRow;
    readonly tone: ChartTone;
}

export const OTHER_KEY = "__other";

export interface ChartBand {
    readonly key: string;
    readonly label: string;
    readonly tone: ChartTone;
    readonly values: readonly number[];
}

const TOP_TONES = ["m0", "m1", "m2"] as const;

function modelKey(row: UsageModelRow): string {
    return `${row.provider}/${row.model}`;
}

/**
 * Every route in report order. The three routes with the most spend own the
 * m0..m2 tones; all other routes fold into Other. Unpriced routes stay in the
 * list with no spend and draw no area.
 */
export function chartSeries(
    models: readonly UsageModelRow[],
): ChartSeries[] {
    const tones = new Map<string, ChartTone>();
    [...models]
        .filter((row) => row.spend > 0)
        .sort((left, right) => right.spend - left.spend)
        .slice(0, TOP_TONES.length)
        .forEach((row, index) => {
            tones.set(modelKey(row), TOP_TONES[index]!);
        });
    return models.map((row) => {
        const key = modelKey(row);
        return { key, row, tone: tones.get(key) ?? "rest" };
    });
}

/** Only priced spend draws area; zero-spend routes never create a band. */
export function chartBands(
    timeline: readonly UsageTimelinePoint[],
    models: readonly UsageModelRow[],
): { bands: ChartBand[]; totals: number[] } {
    const priced = chartSeries(models).filter((series) =>
        series.row.spend > 0
    );
    const top = priced.filter((series) => series.tone !== "rest");
    const rest = priced.filter((series) => series.tone === "rest");
    const topKeys = new Set(top.map((series) => series.key));
    const bands: ChartBand[] = top.map((series) => ({
        key: series.key,
        label: series.key,
        tone: series.tone,
        values: timeline.map((point) => point.byModel
            .filter((row) => `${row.provider}/${row.model}` === series.key)
            .reduce((sum, row) => sum + row.spend, 0)),
    }));
    if (rest.length > 0) {
        bands.push({
            key: OTHER_KEY,
            label: `Other (${rest.length})`,
            tone: "rest",
            values: timeline.map((point) => point.byModel.reduce(
                (sum, row) => topKeys.has(`${row.provider}/${row.model}`)
                    ? sum
                    : sum + row.spend,
                0,
            )),
        });
    }
    return {
        bands,
        totals: timeline.map((_, index) =>
            bands.reduce((sum, band) => sum + band.values[index]!, 0)
        ),
    };
}

const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
] as const;

interface DayParts {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

function dayParts(key: string): DayParts | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (match === null) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    return { year, month, day };
}

function dayLabel(parts: DayParts, withYear: boolean): string {
    const base = `${MONTHS[parts.month - 1]} ${parts.day}`;
    return withYear ? `${base}, ${parts.year}` : base;
}

export function bucketAxisLabel(
    point: UsageTimelinePoint,
    bucket: UsageTimelineBucket,
): string {
    const start = dayParts(point.start);
    if (start === undefined) return point.start;
    if (bucket === "month") return `${MONTHS[start.month - 1]} ${start.year}`;
    return dayLabel(start, false);
}

export function bucketRangeLabel(
    point: UsageTimelinePoint,
    bucket: UsageTimelineBucket,
): string {
    const start = dayParts(point.start);
    const end = dayParts(point.end);
    if (start === undefined || end === undefined) return point.start;
    if (bucket === "day" || point.start === point.end) {
        return dayLabel(start, start.year !== end.year);
    }
    const crossesYear = start.year !== end.year;
    return `${dayLabel(start, crossesYear)} to ${dayLabel(end, crossesYear)}`;
}

interface CurveSegment {
    readonly fromX: number;
    readonly fromY: number;
    readonly c1x: number;
    readonly c1y: number;
    readonly c2x: number;
    readonly c2y: number;
    readonly x: number;
    readonly y: number;
}

/**
 * Fritsch-Butland tangents. A zero tangent at every local extreme keeps the
 * cubic inside the segment's endpoint values, so an area never dips below zero.
 */
function segments(
    xs: readonly number[],
    ys: readonly number[],
): CurveSegment[] {
    const count = xs.length;
    if (count < 2) return [];
    const slopes: number[] = [];
    for (let index = 0; index < count - 1; index += 1) {
        const width = xs[index + 1]! - xs[index]!;
        slopes.push(width === 0 ? 0 : (ys[index + 1]! - ys[index]!) / width);
    }
    const tangents = new Array<number>(count);
    tangents[0] = slopes[0]!;
    tangents[count - 1] = slopes[count - 2]!;
    for (let index = 1; index < count - 1; index += 1) {
        const left = slopes[index - 1]!;
        const right = slopes[index]!;
        tangents[index] = left * right <= 0
            ? 0
            : (2 * left * right) / (left + right);
    }
    const out: CurveSegment[] = [];
    for (let index = 0; index < count - 1; index += 1) {
        const width = xs[index + 1]! - xs[index]!;
        const fromX = xs[index]!;
        const fromY = ys[index]!;
        const x = xs[index + 1]!;
        const y = ys[index + 1]!;
        out.push({
            fromX,
            fromY,
            c1x: fromX + width / 3,
            c1y: fromY + (tangents[index]! * width) / 3,
            c2x: x - width / 3,
            c2y: y - (tangents[index + 1]! * width) / 3,
            x,
            y,
        });
    }
    return out;
}

export function monotonePath(
    xs: readonly number[],
    ys: readonly number[],
): string {
    if (xs.length === 0) return "";
    let path = `M${xs[0]},${ys[0]}`;
    for (const segment of segments(xs, ys)) {
        path += `C${segment.c1x},${segment.c1y} ${segment.c2x},${segment.c2y} ${segment.x},${segment.y}`;
    }
    return path;
}

/** Upper edge left to right, lower edge right to left, closed at the baseline. */
export function areaPath(
    xs: readonly number[],
    upper: readonly number[],
    lower: readonly number[] | undefined,
    baseline: number,
): string {
    if (xs.length === 0) return "";
    let path = `M${xs[0]},${upper[0]}`;
    for (const segment of segments(xs, upper)) {
        path += `C${segment.c1x},${segment.c1y} ${segment.c2x},${segment.c2y} ${segment.x},${segment.y}`;
    }
    const lastX = xs[xs.length - 1]!;
    if (lower !== undefined && lower.length === xs.length) {
        path += `L${lastX},${lower[lower.length - 1]}`;
        const lowerSegments = segments(xs, lower);
        for (let index = lowerSegments.length - 1; index >= 0; index -= 1) {
            const segment = lowerSegments[index]!;
            path += `C${segment.c2x},${segment.c2y} ${segment.c1x},${segment.c1y} ${segment.fromX},${segment.fromY}`;
        }
    } else {
        path += `L${lastX},${baseline}L${xs[0]},${baseline}`;
    }
    return `${path}Z`;
}
