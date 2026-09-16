
import type { ReachabilityCheck } from "../config/model-assignments.ts";
import type { PoolFile } from "./pool-file.ts";
import { isSelectable } from "./pool-policy.ts";

export function poolReachability(file: PoolFile): ReachabilityCheck {
    return (entry) => {
        const id = `${entry.provider}/${entry.model}`;
        return isSelectable(id, file);
    };
}
