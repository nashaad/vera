import { useCallback, useSyncExternalStore } from "react";

import { getDiffComments, subscribeDiffComments, type StoredDiffComment } from "./diff-comments.ts";

export function useDiffComments(sessionId: string): readonly StoredDiffComment[] {
    const subscribe = useCallback((listener: () => void) => subscribeDiffComments(sessionId, listener), [sessionId]);
    const snapshot = useCallback(() => getDiffComments(sessionId), [sessionId]);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}
