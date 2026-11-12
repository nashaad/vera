import type { ReactNode } from "react";

import { NAVIGATION_COMMANDS } from "../commands/navigation-commands.ts";
import { BellIcon, BlocksIcon, ComposeIcon, SearchIcon, type IconProps } from "../components/Icons.tsx";
import { useRouter } from "../pages/router.tsx";
import type { PageKind } from "../pages/routes.ts";
import { waitingCount } from "../protocol/sessionGroups.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useWorkbench } from "./context.tsx";

interface NavEntry {
    readonly page: PageKind;
    readonly title: string;
    readonly command: string;
    readonly Icon: (props: IconProps) => ReactNode;
}

const ENTRIES: readonly NavEntry[] = [
    { page: "home", title: "New Chat", command: NAVIGATION_COMMANDS.newChat, Icon: ComposeIcon },
    { page: "search", title: "Search", command: NAVIGATION_COMMANDS.search, Icon: SearchIcon },
    { page: "work", title: "Work", command: NAVIGATION_COMMANDS.work, Icon: BellIcon },
    { page: "customize", title: "Customize", command: NAVIGATION_COMMANDS.customize, Icon: BlocksIcon },
];

// The pages of the main area; they stay above the sidebar's view containers wherever those move.
export function SidebarNav() {
    const { run } = useWorkbench();
    const { route } = useRouter();
    const { connection } = useViewEnvironment();
    const waiting = waitingCount(connection.sessionRows ?? []);
    return (
        <nav className="sidebar-nav" aria-label="Pages">
            {ENTRIES.map(({ page, title, command, Icon }) => (
                <button
                    key={page}
                    type="button"
                    className="nav-row"
                    data-page={page}
                    data-active={route.kind === page}
                    aria-current={route.kind === page ? "page" : undefined}
                    onClick={() => run(command)}
                >
                    <Icon className="nav-icon" />
                    <span className="nav-title">{title}</span>
                    {page === "work" && waiting > 0 ? (
                        <span className="nav-count" title={`${waiting} waiting for you`}>{waiting}</span>
                    ) : null}
                </button>
            ))}
        </nav>
    );
}
