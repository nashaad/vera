import type { ReactNode } from "react";

import {
    AgentIcon,
    BoltIcon,
    GlobeIcon,
    BranchIcon,
    EyeIcon,
    FolderIcon,
    KeyIcon,
    LaptopIcon,
    LayersIcon,
    RefreshIcon,
    ShieldIcon,
    ViewIcon,
    type IconProps,
} from "../../components/Icons.tsx";

export interface SettingsSection {
    readonly id: string;
    readonly name: string;
    // The rail heading the section sits under.
    readonly group: "Settings" | "Desktop";
    readonly Icon: (props: IconProps) => ReactNode;
    // Extra words the rail search matches, beside the name.
    readonly terms: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
    {
        id: "appearance",
        name: "Appearance",
        group: "Settings",
        Icon: EyeIcon,
        terms: "theme dark light contrast color text size font code density compact motion animation",
    },
    {
        id: "browser",
        name: "Browser",
        group: "Settings",
        Icon: GlobeIcon,
        terms: "browser pane tools ask refuse settings",
    },
    {
        id: "agents",
        name: "Agents",
        group: "Settings",
        Icon: AgentIcon,
        terms: "agent default persona subagent tools skills posture notes suggest offer keep",
    },
    {
        id: "approvals",
        name: "Approvals",
        group: "Settings",
        Icon: ShieldIcon,
        terms: "permission approve deny allow mode grant always full access",
    },
    {
        id: "providers",
        name: "Providers",
        group: "Settings",
        Icon: LayersIcon,
        terms: "model provider api key pricing favorites shortlist catalog refresh",
    },
    {
        id: "models",
        name: "Models",
        group: "Settings",
        Icon: LayersIcon,
        terms: "model picker favorites shortlist catalog search refresh",
    },
    {
        id: "workspaces",
        name: "Workspaces",
        group: "Settings",
        Icon: FolderIcon,
        terms: "workspace folder project directory repository",
    },
    {
        id: "git",
        name: "Git & PRs",
        group: "Settings",
        Icon: BranchIcon,
        terms: "git branch commit pull request pr worktree",
    },
    {
        id: "devices",
        name: "Devices",
        group: "Settings",
        Icon: LaptopIcon,
        terms: "device machine computer session trusted remote pair client sign out",
    },
    {
        id: "keyboard",
        name: "Keyboard",
        group: "Settings",
        Icon: KeyIcon,
        terms: "keyboard shortcut key binding hotkey accelerator",
    },
    {
        id: "updates",
        name: "Updates",
        group: "Settings",
        Icon: RefreshIcon,
        terms: "update upgrade version release check download automatic ask off install",
    },
    {
        id: "show",
        name: "Show",
        group: "Desktop",
        Icon: ViewIcon,
        terms: "show hide visible auto on off sidebar pane panel page search work plugins customize review plan files output browser reasoning doctor developer tour coverage devices",
    },
    {
        id: "data",
        name: "Data",
        group: "Desktop",
        Icon: BoltIcon,
        terms: "data storage space disk size free clean reset layout appearance sessions count folder chromium machine desktop",
    },
];
