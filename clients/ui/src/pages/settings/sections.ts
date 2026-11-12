import type { ReactNode } from "react";

import {
    AgentIcon,
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
        Icon: EyeIcon,
        terms: "theme dark light contrast color text size font code density compact motion animation",
        file: "This window's own storage, not the Vera home",
    },
    {
        id: "agents",
        name: "Agents",
        Icon: AgentIcon,
        terms: "agent default persona subagent tools skills posture",
        file: "agents/*.md in the folder and the Vera home",
    },
    {
        id: "approvals",
        name: "Approvals",
        Icon: ShieldIcon,
        terms: "permission approve deny allow mode grant always",
        file: "config.json and preferences.json in the Vera home",
    },
    {
        id: "providers",
        name: "Providers",
        Icon: LayersIcon,
        terms: "model provider api key pricing shortlist catalog refresh",
        file: "config.json and the model catalog cache in the Vera home",
    },
    {
        id: "workspaces",
        name: "Workspaces",
        Icon: FolderIcon,
        terms: "workspace folder project directory repository",
        file: "Read from the sessions the host lists",
    },
    {
        id: "git",
        name: "Git & PRs",
        Icon: BranchIcon,
        terms: "git branch commit pull request pr worktree",
        file: "Not served by the host yet",
    },
    {
        id: "devices",
        name: "Devices",
        Icon: LaptopIcon,
        terms: "device machine computer session trusted remote pair client sign out",
        file: "Read from the host this window is attached to",
    },
    {
        id: "keyboard",
        name: "Keyboard",
        Icon: KeyIcon,
        terms: "keyboard shortcut key binding hotkey accelerator",
        file: "Built into this window",
    },
];
