
export const MAX_CONSECUTIVE_TOOL_DENIALS_PER_TURN = 3;

export type ToolDenialBreakerAction = "withheld" | "ended-turn";

export interface ToolDenialBreakerTrip {
    readonly tool: string;
    readonly denials: number;
    readonly action: ToolDenialBreakerAction;
}

export interface ToolDenialBreaker {
    recordDenial(tool: string): ToolDenialBreakerTrip | undefined;
    /** Records that a call of this tool was allowed to run. Only the same tool's counter resets: a turn that is refused one tool while hundreds of calls to other tools succeed is. */
    recordAllowed(tool: string): void;
    isWithheld(tool: string): boolean;
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

export function toolDenialBreakerInterrupt(
    trip: ToolDenialBreakerTrip,
): string {
    return `The turn was ended by the tool denial breaker: ${trip.tool} was`
        + ` refused ${trip.denials} times in a row after another tool had`
        + " already been withheld this turn. Say what you want to happen next.";
}

export function withheldToolReason(tool: string): string {
    return `The ${tool} tool was withheld for the rest of this turn after`
        + ` ${MAX_CONSECUTIVE_TOOL_DENIALS_PER_TURN} refusals in a row.`;
}
