import {
    startTui,
    type TuiDependencies,
} from "../../clients/tui/main.ts";
import { createTuiChildDependencies } from "./tui-child.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export interface TuiAgentNoticeOptions {
    /** The session is a background child, so it offers a way back up. */
    readonly hasParent?: boolean;
    /** Display names of the running background children of this session. */
    readonly children?: readonly string[];
}

/** A session that attaches already knowing the agents around it. */
export function createTuiAgentNoticeDependencies(
    options: TuiAgentNoticeOptions = {},
): TuiDependencies {
    const base = createTuiChildDependencies();
    const children = options.children ?? [];
    return {
        ...base,
        client: {
            ...base.client,
            backgroundAgents: {
                running: children.length,
                children,
                has_parent: options.hasParent ?? false,
            },
        },
    };
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createTuiAgentNoticeDependencies({
        hasParent: process.env.VERA_TEST_HAS_PARENT === "1",
        children: (process.env.VERA_TEST_CHILDREN ?? "")
            .split(",")
            .filter((name) => name.length > 0),
    }));
}
