/**
 * The pool's answer to whether a slot's models can be reached.
 *
 * Config asks this question and does not know how it is answered, which keeps
 * the pool the only place that holds availability. The adapter lives here, on
 * the pool's side of that line.
 */

import type { ReachabilityCheck } from "../config/model-assignments.ts";
import type { PoolFile } from "./pool-file.ts";
import { isSelectable } from "./pool-policy.ts";

/**
 * A model is reachable when it is in the pool and the pool allows selecting
 * it. A model absent from the pool is not reachable: the pool is what the user
 * has admitted, so naming a route entry that was never admitted is the same
 * situation as naming one that is currently down.
 */
export function poolReachability(file: PoolFile): ReachabilityCheck {
    return (entry) => {
        const id = `${entry.provider}/${entry.model}`;
        // isSelectable applies the allow and deny rules only, so membership
        // is a separate question and has to be asked first.
        return file.models[id] !== undefined && isSelectable(id, file);
    };
}
