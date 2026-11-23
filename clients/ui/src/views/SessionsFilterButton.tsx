import { FilterIcon } from "../components/Icons.tsx";
import type { MenuEntry } from "../commands/menus.ts";
import { SIDEBAR_COMMANDS } from "../commands/sidebar-commands.ts";
import { useSidebarGrouping } from "../state/useSidebarGrouping.ts";
import { useWorkbench } from "../workbench/context.tsx";

// The sessions list's filter control. Grouping is the only choice it carries.
export function SessionsFilterButton() {
    const grouping = useSidebarGrouping();
    const { openMenu } = useWorkbench();
    const open = (target: HTMLElement): void => {
        const box = target.getBoundingClientRect();
        const entries: readonly MenuEntry[] = [
            { kind: "item", label: "Group by", command: "", disabled: true, hint: grouping === "folder" ? "Folder" : "None" },
            { kind: "item", label: "Folder", command: SIDEBAR_COMMANDS.groupFolder, checked: grouping === "folder" },
            { kind: "item", label: "None", command: SIDEBAR_COMMANDS.groupNone, checked: grouping === "none" },
        ];
        openMenu(entries, { x: box.left, y: box.bottom });
    };
    return (
        <button
            type="button"
            className="icon-button sessions-filter"
            aria-label={`Filter sessions, grouped by ${grouping === "folder" ? "Folder" : "None"}`}
            aria-haspopup="menu"
            title="Filter sessions"
            onClick={(event) => open(event.currentTarget)}
        >
            <FilterIcon />
        </button>
    );
}
