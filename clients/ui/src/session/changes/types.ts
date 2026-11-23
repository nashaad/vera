import type { FileDiffMetadata } from "@pierre/diffs";

import type { GitScope } from "../../../../shared/git-wire.ts";
import type { DiffCommentAnnotation, PendingComment } from "../DiffComments.tsx";
import type { CachedPatch } from "../gitChanges.ts";

export type LoadStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface ChangesPending extends PendingComment {
    readonly path: string;
    readonly source: FileDiffMetadata;
}

export interface ChangesQuery {
    readonly scope: GitScope;
    readonly destination: string | null;
}

export type ChangesAnnotation = DiffCommentAnnotation | { readonly kind: "file-editor"; readonly path: string };

export interface PatchCache {
    readonly current: ReadonlyMap<string, CachedPatch>;
}
