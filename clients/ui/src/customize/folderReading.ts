import type { FolderCustomizationsResult, FolderCustomizationsAnswer } from "../protocol/bridge.ts";

// What the host listed for a folder, or for a chat when there is none, with no session behind it.
export type FolderReadState =
    | { readonly phase: "loading" }
    | { readonly phase: "ready"; readonly reading: FolderCustomizationsAnswer }
    | { readonly phase: "failed"; readonly reason: string };

export const LOADING: FolderReadState = { phase: "loading" };

export const NO_BRIDGE_REASON = "This window has no host bridge.";
export const NO_ANSWER_REASON = "The host did not answer.";

// A read that starts over a ready list keeps the list until its answer arrives; anything else starts loading.
export function readingStartState(previous: FolderReadState): FolderReadState {
    return previous.phase === "ready" ? previous : LOADING;
}

export function folderReadOutcome(result: FolderCustomizationsResult): FolderReadState {
    return result.ok ? { phase: "ready", reading: result } : { phase: "failed", reason: result.reason };
}
