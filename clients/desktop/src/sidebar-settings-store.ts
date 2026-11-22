import { join } from "node:path";

import { parseSidebarSettings, type SidebarSettings } from "../../ui/src/protocol/sidebarSettings.ts";
import { JsonFileStore } from "./json-file-store.ts";

const MAX_SIDEBAR_SETTINGS_BYTES = 4_096;

// The sidebar's own settings sit beside the layout and pins in the desktop's directory under the home.
export function sidebarSettingsPath(home: string): string {
    return join(home, "machine", "desktop", "sidebar.json");
}

export class SidebarSettingsStore extends JsonFileStore<SidebarSettings> {
    constructor(path: string) {
        super(path, MAX_SIDEBAR_SETTINGS_BYTES, parseSidebarSettings);
    }
}
