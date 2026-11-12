import type { ReactNode } from "react";

import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { PanelIcon, SidebarIcon, SidebarRightIcon } from "../components/Icons.tsx";
import type { IconProps } from "../components/Icons.tsx";
import { shortcutKeys } from "./hints.ts";

interface Hint {
    readonly title: string;
    readonly detail: string;
    readonly command: string;
    readonly Icon: (props: IconProps) => ReactNode;
}

const HINTS: readonly Hint[] = [
    { title: "Sidebar", detail: "Sessions and their status", command: LAYOUT_COMMANDS.toggleSidebar, Icon: SidebarIcon },
    { title: "Right pane", detail: "The host this window is attached to", command: LAYOUT_COMMANDS.toggleRightPane, Icon: SidebarRightIcon },
    { title: "Panel", detail: "Connection output", command: LAYOUT_COMMANDS.togglePanel, Icon: PanelIcon },
];

// The transcript is not here yet, so the main area says what it will hold.
export function Welcome({ platform }: { readonly platform: string }) {
    return (
        <div className="welcome">
            <div className="welcome-inner">
                <h1 className="welcome-title">Where to, captain?</h1>
                <p className="welcome-note">Conversations open here. Until then, these show and hide the rest of the window.</p>
                <ul className="welcome-keys">
                    {HINTS.map(({ title, detail, command, Icon }) => (
                        <li key={command} className="welcome-key" data-command={command}>
                            <Icon className="welcome-key-icon" />
                            <span className="welcome-key-title">{title}</span>
                            <span className="welcome-key-detail">{detail}</span>
                            <span className="welcome-key-keys">
                                {shortcutKeys(command, platform).map((key) => <kbd key={key} className="kbd">{key}</kbd>)}
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
