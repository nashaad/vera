import { useSyncExternalStore } from "react";

import type { DesktopExtensionEntry } from "../protocol/extensions.ts";
import { desktopExtensions, isExtensionOn, subscribeDesktopExtensions } from "./state.ts";

export function useExtensionOn(id: string): boolean {
    return useSyncExternalStore(subscribeDesktopExtensions, () => isExtensionOn(id));
}

// The desktop extensions as last listed; undefined until the shell has answered.
export function useDesktopExtensions(): readonly DesktopExtensionEntry[] | undefined {
    return useSyncExternalStore(subscribeDesktopExtensions, desktopExtensions);
}
