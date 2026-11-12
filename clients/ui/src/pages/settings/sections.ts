import type { ReactNode } from "react";

import {
    AgentIcon,
    BoltIcon,
    BranchIcon,
    EyeIcon,
    FolderIcon,
    KeyIcon,
    LaptopIcon,
    LayersIcon,
    ShieldIcon,
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
    // The file the section's settings live in, shown above it.
    readonly file: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
    {
        id: "appearance",
        name: "Appearance",
        group: "Settings",
        Icon: EyeIcon,
        terms: "theme dark light contrast color text size font code density compact motion animation",
        file: "The desktop's storage under machine/desktop in the Vera home",
    },
    {
        id: "agents",
        name: "Agents",
        group: "Settings",
        Icon: AgentIcon,
        terms: "agent default persona subagent tools skills posture",
        file: "agents/*.md in the folder and the Vera home",
    },
    {
        id: "approvals",
        name: "Approvals",
        group: "Settings",
        Icon: ShieldIcon,
        terms: "permission approve deny allow mode grant always full access",
        file: "config.json and preferences.json in the Vera home",
    },
    {
        id: "providers",
        name: "Providers",
        group: "Settings",
        Icon: LayersIcon,
        terms: "model provider api key pricing shortlist catalog refresh",
        file: "config.json and the model catalog cache in the Vera home",
    },
    {
        id: "workspaces",
        name: "Workspaces",
        group: "Settings",
        Icon: FolderIcon,
        terms: "workspace folder project directory repository",
        file: "Read from the sessions the host lists",
    },
    {
        id: "git",
        name: "Git & PRs",
        group: "Settings",
        Icon: BranchIcon,
        terms: "git branch commit pull request pr worktree",
        file: "Not served by the host",
    },
    {
        id: "devices",
        name: "Devices",
        group: "Settings",
        Icon: LaptopIcon,
        terms: "device machine computer session trusted remote pair client sign out",
        file: "Read from the host this window is attached to",
    },
    {
        id: "keyboard",
        name: "Keyboard",
        group: "Settings",
        Icon: KeyIcon,
        terms: "keyboard shortcut key binding hotkey accelerator",
        file: "Built into this window",
    },
    {
        id: "data",
        name: "Data",
        group: "Desktop",
        Icon: BoltIcon,
        terms: "data storage reset layout appearance sessions count folder chromium machine desktop",
        file: "machine/desktop in the Vera home",
    },
];
