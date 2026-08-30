/**
 * Vera's WA Score × listed-output front. Y is WA Score (higher is better).
 * X is OpenRouter listed output USD per million (lower is better).
 *
 * This is not Arena's Pareto page and not a blended dollar figure.
 */

export interface ParetoCandidate {
    readonly key: string;
    readonly score: number;
    readonly output: number;
}

const NEAR_POINTS = 25;
const LOG_FLOOR = 0.001;

/**
 * Keys that are on the strict front or within 25 Arena points of the
 * piecewise-linear front in log-price vs score.
 */
export function paretoKeys(
    candidates: readonly ParetoCandidate[],
): ReadonlySet<string> {
    const usable = candidates.filter((candidate) =>
        Number.isFinite(candidate.score)
        && Number.isFinite(candidate.output)
        && candidate.output >= 0
    );
    const front = strictFront(usable);
    const marked = new Set(front.map((point) => point.key));
    if (front.length === 0) {
        return marked;
    }
    const sorted = [...front].toSorted((left, right) => left.output - right.output);
    for (const candidate of usable) {
        if (marked.has(candidate.key)) {
            continue;
        }
        const delta = frontScoreAt(candidate.output, sorted) - candidate.score;
        if (delta <= NEAR_POINTS) {
            marked.add(candidate.key);
        }
    }
    return marked;
}

function strictFront(
    candidates: readonly ParetoCandidate[],
): readonly ParetoCandidate[] {
    return candidates.filter((candidate) =>
        !candidates.some((other) =>
            other.key !== candidate.key && dominates(other, candidate)
        )
    );
}

/**
 * A dominates B when A is at least as good on both axes and strictly better
 * on at least one: higher score, lower or equal output.
 */
function dominates(left: ParetoCandidate, right: ParetoCandidate): boolean {
    return left.score >= right.score
        && left.output <= right.output
        && (left.score > right.score || left.output < right.output);
}

function frontScoreAt(
    output: number,
    front: readonly ParetoCandidate[],
): number {
    const logX = logPrice(output);
    const first = front[0]!;
    const last = front[front.length - 1]!;
    if (logX <= logPrice(first.output)) {
        return first.score;
    }
    if (logX >= logPrice(last.output)) {
        return last.score;
    }
    for (let index = 0; index < front.length - 1; index += 1) {
        const left = front[index]!;
        const right = front[index + 1]!;
        const leftX = logPrice(left.output);
        const rightX = logPrice(right.output);
        if (logX < leftX || logX > rightX) {
            continue;
        }
        if (rightX === leftX) {
            return Math.max(left.score, right.score);
        }
        const t = (logX - leftX) / (rightX - leftX);
        return left.score + (right.score - left.score) * t;
    }
    return last.score;
}

function logPrice(output: number): number {
    return Math.log10(Math.max(output, LOG_FLOOR));
}
