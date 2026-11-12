import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { MenuEntry } from "../commands/menus.ts";
import type { LayoutAction } from "../layout/reducer.ts";
import type { ResolvedLayout } from "../layout/resolve.ts";
import { ContextMenu } from "./ContextMenu.tsx";
import { WorkbenchContext, type WorkbenchApi } from "./context.tsx";
import { DragProvider } from "./drag.tsx";

interface OpenMenu {
    readonly entries: readonly MenuEntry[];
    readonly x: number;
    readonly y: number;
}

export interface WorkbenchProviderProps {
    readonly layout: ResolvedLayout;
    readonly dispatch: (action: LayoutAction) => void;
    readonly run: (command: string, args?: unknown) => void;
    readonly children: ReactNode;
}

export function WorkbenchProvider({ layout, dispatch, run, children }: WorkbenchProviderProps) {
    const [menu, setMenu] = useState<OpenMenu | undefined>(undefined);
    const closeMenu = useCallback(() => setMenu(undefined), []);
    const openMenu = useCallback<WorkbenchApi["openMenu"]>((entries, at) => {
        if (entries.length > 0) setMenu({ entries, x: at.x, y: at.y });
    }, []);
    const api = useMemo<WorkbenchApi>(
        () => ({ layout, dispatch, run, openMenu }),
        [layout, dispatch, run, openMenu],
    );
    return (
        <WorkbenchContext.Provider value={api}>
            <DragProvider>
                {children}
                {menu === undefined ? null : (
                    <ContextMenu
                        entries={menu.entries}
                        x={menu.x}
                        y={menu.y}
                        onRun={(command, args) => run(command, args)}
                        onClose={closeMenu}
                    />
                )}
            </DragProvider>
        </WorkbenchContext.Provider>
    );
}
