import { defineAgent, type AgentDefinition } from "../../index.ts";

export const CORRECTNESS_INSTRUCTIONS = `Trace the changed control flow and find defects that make the implementation produce the wrong result, lose state, violate an invariant, or mishandle a boundary case. Prefer a concrete failure path over a general concern. Return only JSON with this exact shape: {"findings":[{"summary":"non-empty text","severity":"critical|high|medium|low","file":"optional path","line":1,"mechanism":"non-empty failure mechanism","evidence":"non-empty evidence from the target","suggestedFix":"optional smallest correction"}]}. Use an empty findings array when no defect is supported.`;

export const SECURITY_INSTRUCTIONS = `Challenge the change as an untrusted caller. Look for widened authority, missing validation, unsafe path or command handling, secret exposure, confused ownership, and ways a denied action can still execute. Report only defects supported by the supplied target. Return only JSON with this exact shape: {"findings":[{"summary":"non-empty text","severity":"critical|high|medium|low","file":"optional path","line":1,"mechanism":"non-empty failure mechanism","evidence":"non-empty evidence from the target","suggestedFix":"optional smallest correction"}]}. Use an empty findings array when no defect is supported.`;

export const REPRODUCTION_INSTRUCTIONS = `Construct the smallest realistic reproduction for each suspected regression. Check whether inputs, ordering, failure handling, and cleanup make the defect observable rather than merely possible. Reject concerns that cannot be connected to an executable path. Return only JSON with this exact shape: {"findings":[{"summary":"non-empty text","severity":"critical|high|medium|low","file":"optional path","line":1,"mechanism":"non-empty failure mechanism","evidence":"non-empty evidence from the target","suggestedFix":"optional smallest correction"}]}. Use an empty findings array when no defect is supported.`;

export const REFUTER_INSTRUCTIONS = `Try to disprove the supplied finding against the task and immutable target. Check whether the cited path is reachable, whether existing guards prevent it, and whether the evidence supports the claimed severity. Do not replace the finding with a different concern. Return only JSON with this exact shape: {"refuted":true,"reasoning":"non-empty evidence-based explanation"}. Set refuted to false when the finding survives.`;

export const correctness = defineAgent({
    name: "review-correctness",
    description: "Finds defects that make the code do the wrong thing",
    instructions: CORRECTNESS_INSTRUCTIONS,
    tools: ["read", "grep"],
    posture: "readonly",
});

export const security = defineAgent({
    name: "review-security",
    description: "Finds authority and trust-boundary defects",
    instructions: SECURITY_INSTRUCTIONS,
    tools: ["read", "grep"],
    posture: "readonly",
});

export const reproduction = defineAgent({
    name: "review-reproduction",
    description: "Tests whether a suspected defect has a concrete reproduction",
    instructions: REPRODUCTION_INSTRUCTIONS,
    tools: ["read", "grep"],
    posture: "readonly",
});

export const refuter = defineAgent({
    name: "review-refuter",
    description: "Tries to prove one finding wrong",
    instructions: REFUTER_INSTRUCTIONS,
    tools: [],
    posture: "readonly",
    defaultPair: { name: "luna", effort: "high" },
});

export interface ReviewLens {
    readonly name: ReviewLensName;
    readonly definition: AgentDefinition;
}

export type ReviewLensName = "correctness" | "security" | "reproduction";

export const REVIEW_LENSES: readonly ReviewLens[] = [
    { name: "correctness", definition: correctness },
    { name: "security", definition: security },
    { name: "reproduction", definition: reproduction },
];
