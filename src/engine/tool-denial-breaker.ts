/**
 * Bounds what a turn does after the harness automatically refuses a tool.
 *
 * The signal is the denial itself, so there is no similarity heuristic here
 * and none is wanted: an agent that keeps calling a tool the policy keeps
 * refusing is not exploring, and the refusal is already a fact the engine
 * produced. Denials the user made in person are not counted by the caller,
 * because a person answering "no" twice is a conversation, not a runaway.
 *
 * Two stages. The first trip withholds one tool, which leaves a turn free to
 * route around a single closed path. The second trip in the same turn ends
 * the turn, which is the case where the turn switched tools and kept being
 * refused.
 */

/**
 * Automatic denials of one tool, in a row, before that tool is withheld.
 *
 * Same value as `MAX_CONSECUTIVE_REVIEW_DENIALS_PER_TURN`, which the repo
 * already treats as the point where a run is retrying rather than exploring.
 */
export const MAX_CONSECUTIVE_TOOL_DENIALS_PER_TURN = 3;

export type ToolDenialBreakerAction = "withheld" | "ended-turn";

export interface ToolDenialBreakerTrip {
    readonly tool: string;
    /** Consecutive automatic denials of that tool when the trip happened. */
    readonly denials: number;
    readonly action: ToolDenialBreakerAction;
}

export interface ToolDenialBreaker {
    /**
     * Records one automatic denial. Returns the trip when this denial crossed
     * the threshold, or `undefined` while the turn is still inside it.
     */
    recordDenial(tool: string): ToolDenialBreakerTrip | undefined;
    /**
     * Records that a call of this tool was allowed to run. Only the same
     * tool's counter resets: a turn that is refused one tool while hundreds of
     * calls to other tools succeed is exactly the shape being bounded, so a
     * different tool succeeding must not clear it.
     */
    recordAllowed(tool: string): void;
    /** True once this tool has been withheld for the rest of the turn. */
    isWithheld(tool: string): boolean;
    /** The offered tools, minus the ones withheld. */
    filterOffered<T extends { readonly name: string }>(
        offered: readonly T[],
    ): readonly T[];
}

export function createToolDenialBreaker(): ToolDenialBreaker {
    const consecutive = new Map<string, number>();
    const withheld = new Set<string>();
    return {
        recordDenial(tool) {
            const denials = (consecutive.get(tool) ?? 0) + 1;
            consecutive.set(tool, denials);
            if (denials < MAX_CONSECUTIVE_TOOL_DENIALS_PER_TURN) {
                return undefined;
            }
            // A withheld tool can only be counted again by being called after
            // it stopped being offered, which is the same brute force as
            // switching tools and is treated the same way.
            if (withheld.size > 0) {
                return { tool, denials, action: "ended-turn" };
            }
            withheld.add(tool);
            return { tool, denials, action: "withheld" };
        },
        recordAllowed(tool) {
            consecutive.set(tool, 0);
        },
        isWithheld(tool) {
            return withheld.has(tool);
        },
        filterOffered(offered) {
            return withheld.size === 0
                ? offered
                : offered.filter((tool) => !withheld.has(tool.name));
        },
    };
}

/** What the turn's terminal message says when the breaker ends a turn. */
export function toolDenialBreakerInterrupt(
    trip: ToolDenialBreakerTrip,
): string {
    return `The turn was ended by the tool denial breaker: ${trip.tool} was`
        + ` refused ${trip.denials} times in a row after another tool had`
        + " already been withheld this turn. Say what you want to happen next.";
}

/** What a call of an already withheld tool is refused with. */
export function withheldToolReason(tool: string): string {
    return `The ${tool} tool was withheld for the rest of this turn after`
        + ` ${MAX_CONSECUTIVE_TOOL_DENIALS_PER_TURN} refusals in a row.`;
}
