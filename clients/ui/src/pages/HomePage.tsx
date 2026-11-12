import type { ReactNode } from "react";

import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { PanelIcon, SidebarIcon, SidebarRightIcon } from "../components/Icons.tsx";
import type { IconProps } from "../components/Icons.tsx";
import { shortcutKeys } from "../workbench/hints.ts";

interface Hint {
    readonly title: string;
    readonly detail: string;
    readonly command: string;
    readonly Icon: (props: IconProps) => ReactNode;
}

const HINTS: readonly Hint[] = [
    { title: "Sidebar", detail: "Pages and sessions", command: LAYOUT_COMMANDS.toggleSidebar, Icon: SidebarIcon },
    { title: "Right pane", detail: "The host this window is attached to", command: LAYOUT_COMMANDS.toggleRightPane, Icon: SidebarRightIcon },
    { title: "Panel", detail: "Connection output", command: LAYOUT_COMMANDS.togglePanel, Icon: PanelIcon },
];

// New Chat. The composer is not here yet, so the page lists the window's toggles.
export function HomePage({ platform }: { readonly platform: string }) {
    return (
        <div className="page-scroll">
            <div className="home">
                <div className="home-inner">
                    <h1 className="greeting">Where to, captain?</h1>
                    <ul className="home-keys">
                        {HINTS.map(({ title, detail, command, Icon }) => (
                            <li key={command} className="home-key" data-command={command}>
                                <Icon className="home-key-icon" />
                                <span className="home-key-title">{title}</span>
                                <span className="home-key-detail">{detail}</span>
                                <span className="home-key-keys">
                                    {shortcutKeys(command, platform).map((key) => <kbd key={key} className="kbd">{key}</kbd>)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}
