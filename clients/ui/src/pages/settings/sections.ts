import type { ReactNode } from "react";

import { LaptopIcon, LayersIcon, ShieldIcon, type IconProps } from "../../components/Icons.tsx";

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
        id: "devices",
        name: "Devices",
        Icon: LaptopIcon,
        terms: "device machine computer session trusted remote pair client sign out",
        file: "Read from the host this window is attached to",
    },
];
