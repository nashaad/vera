import { createContext, useContext } from "react";

import type { MenuEntry } from "../commands/menus.ts";
import type { LocationId } from "../layout/model.ts";
import type { LayoutAction } from "../layout/reducer.ts";
import type { ResolvedLayout } from "../layout/resolve.ts";

export interface WorkbenchApi {
    readonly layout: ResolvedLayout;
    readonly dispatch: (action: LayoutAction) => void;
    readonly run: (command: string, args?: unknown) => void;
    readonly openMenu: (entries: readonly MenuEntry[], at: { readonly x: number; readonly y: number }) => void;
}

export const WorkbenchContext = createContext<WorkbenchApi | undefined>(undefined);

export function useWorkbench(): WorkbenchApi {
    const api = useContext(WorkbenchContext);
    if (api === undefined) throw new Error("useWorkbench needs a Workbench.");
    return api;
}

// A location takes space only while it is on and has something to show. The sidebar
// always has its nav rows and footer, so it shows with no views in it.
export function useIsShown(location: LocationId): boolean {
    const { layout } = useWorkbench();
    const resolved = layout.locations[location];
    return resolved.visible && (location === "sidebar" || resolved.containers.length > 0);
}
