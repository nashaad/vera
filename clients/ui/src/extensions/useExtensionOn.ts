import { useSyncExternalStore } from "react";

import { isExtensionOn, subscribeDesktopExtensions } from "./state.ts";

export function useExtensionOn(id: string): boolean {
    return useSyncExternalStore(subscribeDesktopExtensions, () => isExtensionOn(id));
}
