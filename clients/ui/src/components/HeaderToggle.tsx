import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { useIsShown, useWorkbench } from "../workbench/context.tsx";
import { shortcutLabel } from "../workbench/hints.ts";
import { SidebarIcon, SidebarRightIcon } from "./Icons.tsx";

export type HeaderToggleLocation = "sidebar" | "rightPane";

const TOGGLES = {
    sidebar: { label: "Toggle Sidebar", command: LAYOUT_COMMANDS.toggleSidebar, Icon: SidebarIcon },
    rightPane: { label: "Toggle Right Pane", command: LAYOUT_COMMANDS.toggleRightPane, Icon: SidebarRightIcon },
} as const;

export interface HeaderToggleProps {
    readonly location: HeaderToggleLocation;
    // Draws the button filled while its location is shown.
    readonly lit?: boolean;
}

export function HeaderToggle({ location, lit = false }: HeaderToggleProps) {
    const { run } = useWorkbench();
    const shown = useIsShown(location);
    const { label, command, Icon } = TOGGLES[location];
    const hint = shortcutLabel(command, window.veraDesktop?.platform ?? "");
    return (
        <button
            type="button"
            className="header-button"
            aria-label={label}
            aria-pressed={shown}
            title={hint === "" ? label : `${label} (${hint})`}
            data-header-toggle={location}
            data-lit={lit && shown}
            onClick={() => run(command)}
        >
            <Icon />
        </button>
    );
}
