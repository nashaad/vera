import type { PromptContributionMetadata } from "./prompt-contributions.ts";

export type PromptPrefixChangeKind =
    | "added"
    | "removed"
    | "reordered"
    | "content_changed";

export interface PromptPrefixChange {
    readonly id: string;
    readonly owner: string;
    readonly kind: PromptPrefixChangeKind;
    readonly previousOrder?: number;
    readonly currentOrder?: number;
}

export interface PromptPrefixDrift {
    readonly cause: "unexplained";
    readonly changes: readonly PromptPrefixChange[];
}

export class PromptPrefixTracker {
    private previous: readonly PromptContributionMetadata[] | undefined;

    observe(
        contributions: readonly PromptContributionMetadata[],
    ): PromptPrefixDrift | undefined {
        const current = contributions
            .filter((entry) => entry.target === "stable")
            .map((entry) => Object.freeze({ ...entry }));
        const previous = this.previous;
        this.previous = Object.freeze(current);
        if (previous === undefined) {
            return undefined;
        }

        const changes = compareStablePrefix(previous, current);
        return changes.length === 0
            ? undefined
            : { cause: "unexplained", changes };
    }
}

function compareStablePrefix(
    previous: readonly PromptContributionMetadata[],
    current: readonly PromptContributionMetadata[],
): readonly PromptPrefixChange[] {
    const previousById = new Map(previous.map((entry) => [entry.id, entry]));
    const currentById = new Map(current.map((entry) => [entry.id, entry]));
    const previousCommon = previous.filter((entry) => currentById.has(entry.id));
    const currentCommon = current.filter((entry) => previousById.has(entry.id));
    const previousCommonOrder = new Map(
        previousCommon.map((entry, order) => [entry.id, order]),
    );
    const currentCommonOrder = new Map(
        currentCommon.map((entry, order) => [entry.id, order]),
    );
    const changes: PromptPrefixChange[] = [];

    for (const entry of previous) {
        const next = currentById.get(entry.id);
        if (next === undefined) {
            changes.push({
                id: entry.id,
                owner: entry.owner,
                kind: "removed",
                previousOrder: entry.order,
            });
            continue;
        }
        if (entry.sha256 !== next.sha256 || entry.bytes !== next.bytes) {
            changes.push({
                id: entry.id,
                owner: next.owner,
                kind: "content_changed",
                previousOrder: entry.order,
                currentOrder: next.order,
            });
        }
        if (
            previousCommonOrder.get(entry.id)
            !== currentCommonOrder.get(entry.id)
        ) {
            changes.push({
                id: entry.id,
                owner: next.owner,
                kind: "reordered",
                previousOrder: entry.order,
                currentOrder: next.order,
            });
        }
    }

    for (const entry of current) {
        if (!previousById.has(entry.id)) {
            changes.push({
                id: entry.id,
                owner: entry.owner,
                kind: "added",
                currentOrder: entry.order,
            });
        }
    }
    return changes;
}
