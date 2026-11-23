import type { ReactNode } from "react";

import { NAVIGATION_COMMANDS } from "../commands/navigation-commands.ts";
import { BellIcon, BlocksIcon, ComposeIcon, PageIcon, SearchIcon, type IconProps } from "../components/Icons.tsx";
import { extensionPages } from "../pagepane/kinds.ts";
import { usePageLinks } from "../pagepane/PageLinks.tsx";
import { useRouter } from "../pages/router.tsx";
import type { PageKind } from "../pages/routes.ts";
import { waitingCount } from "../protocol/sessionGroups.ts";
import type { FlagKey } from "../state/desktopFlags.ts";
import { useVisibility } from "../state/useSurfaces.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useWorkbench } from "./context.tsx";

interface NavEntry {
    readonly page: PageKind;
    readonly title: string;
    readonly command: string;
    readonly Icon: (props: IconProps) => ReactNode;
    // Absent on New Chat, which is always there.
    readonly flag?: FlagKey;
}

const ENTRIES: readonly NavEntry[] = [
    { page: "home", title: "New Chat", command: NAVIGATION_COMMANDS.newChat, Icon: ComposeIcon },
    { page: "search", title: "Search", command: NAVIGATION_COMMANDS.search, Icon: SearchIcon, flag: "search" },
    { page: "work", title: "Work", command: NAVIGATION_COMMANDS.work, Icon: BellIcon, flag: "work" },
    { page: "customize", title: "Plugins", command: NAVIGATION_COMMANDS.customize, Icon: BlocksIcon, flag: "customize" },
];

// The pages of the main area; they stay above the sidebar's view containers wherever those move.
export function SidebarNav() {
    const { run } = useWorkbench();
    const { route, navigate } = useRouter();
    const { annex } = usePageLinks();
    const { connection } = useViewEnvironment();
    const visible = useVisibility();
    const waiting = waitingCount(connection.sessionRows ?? []);
    return (
        <nav className="sidebar-nav" aria-label="Pages">
            {ENTRIES.filter((entry) => entry.flag === undefined || visible[entry.flag]).map(({ page, title, command, Icon }) => (
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
            {extensionPages(annex?.pages ?? []).map((page) => {
                const active = route.kind === "extension" && route.path === page.path;
                return (
                    <button
                        key={page.path}
                        type="button"
                        className="nav-row"
                        data-page="extension"
                        data-extension-page={page.path}
                        data-active={active}
                        aria-current={active ? "page" : undefined}
                        onClick={() => navigate({ kind: "extension", path: page.path, title: page.label })}
                    >
                        <PageIcon className="nav-icon" />
                        <span className="nav-title">{page.label}</span>
                    </button>
                );
            })}
        </nav>
    );
}
