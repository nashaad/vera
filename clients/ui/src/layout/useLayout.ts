import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { CommandRegistry } from "../commands/registry.ts";
import { registerLayoutCommands } from "../commands/layout-commands.ts";
import { registerOverlayCommands } from "../commands/overlay-commands.ts";
import { registerSessionCommands } from "../commands/session-commands.ts";
import { registerThemeCommands } from "../commands/theme-commands.ts";
import { THEME_IMPORTER_ID } from "../extensions/theme-importer.ts";
import { useExtensionOn } from "../extensions/useExtensionOn.ts";
import { ContributionRegistry } from "../registry/contributions.ts";
import { registerCoreContributions } from "../registry/core.ts";
import { switchTheme } from "../theme/activate.ts";
import { importThemeFromPicker } from "../theme/import-flow.ts";
import { showToast } from "../overlays/toasts.ts";
import { useImportedThemes } from "../theme/useImportedThemes.ts";
import { defaultLayout, type LayoutState } from "./model.ts";
import { createLayoutSaver } from "./persist.ts";
import { forSave } from "./saved.ts";
import { reduceLayout, type LayoutAction } from "./reducer.ts";
import { resolveLayout, type ResolvedLayout } from "./resolve.ts";

const SAVE_DELAY_MS = 400;

function importFromCommand(): void {
    void importThemeFromPicker().then((report) => {
        if (report !== undefined) showToast(report.message, report.ok ? "success" : "danger");
    });
}

export interface LayoutController {
    // False until the saved layout has been read; nothing is drawn or saved before then.
    readonly loaded: boolean;
    readonly layout: ResolvedLayout;
    readonly dispatch: (action: LayoutAction) => void;
    readonly run: (command: string, args?: unknown) => void;
    // Other parts of the window register their own commands here.
    readonly commands: CommandRegistry;
}

interface Services {
    readonly contributions: ContributionRegistry;
    readonly commands: CommandRegistry;
}

function createServices(): Services {
    const contributions = new ContributionRegistry();
    registerCoreContributions(contributions);
    return { contributions, commands: new CommandRegistry() };
}

// `unavailable` names the containers the show flags turn off; they are left out of the layout, not removed from it.
export function useLayout(unavailable: ReadonlySet<string>): LayoutController {
    const [services] = useState(createServices);
    const { contributions, commands } = services;
    // Set before paint so a pane that just turned off never draws once more.
    useLayoutEffect(() => contributions.setUnavailable(unavailable), [contributions, unavailable]);
    const [state, setState] = useState<LayoutState>(defaultLayout);
    const [loaded, setLoaded] = useState(false);
    // The state that came from disk or the last save, so loading alone never writes.
    const baseline = useRef<LayoutState>(state);
    // What was last written, so a change that saving leaves out, such as opening a Browser tab, writes nothing.
    const written = useRef<string | undefined>(undefined);
    const saver = useMemo(
        () => createLayoutSaver((layout) => window.veraDesktop?.saveLayout(layout), SAVE_DELAY_MS),
        [],
    );

    useEffect(() => {
        let cancelled = false;
        const bridge = window.veraDesktop;
        const read = bridge === undefined ? Promise.resolve(undefined) : bridge.loadLayout();
        read.catch(() => undefined).then((saved) => {
            if (cancelled) return;
            if (saved !== undefined) {
                baseline.current = saved;
                written.current = JSON.stringify(saved);
                setState(saved);
            }
            setLoaded(true);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!loaded || state === baseline.current) return;
        baseline.current = state;
        const toSave = forSave(state, (container) => contributions.keepsTabsOut(container));
        const text = JSON.stringify(toSave);
        if (text === written.current) return;
        written.current = text;
        saver.schedule(toSave);
    }, [loaded, state, saver, contributions]);

    useEffect(() => {
        const flush = (): void => saver.flush();
        const onVisibility = (): void => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.removeEventListener("pagehide", flush);
            document.removeEventListener("visibilitychange", onVisibility);
            flush();
        };
    }, [saver]);

    const registry = useSyncExternalStore(
        contributions.subscribe.bind(contributions),
        contributions.snapshot.bind(contributions),
    );
    const layout = useMemo(() => resolveLayout(state, registry), [state, registry]);

    const dispatch = useCallback((action: LayoutAction): void => {
        setState((current) => reduceLayout(current, action, contributions.snapshot()));
    }, [contributions]);

    useEffect(() => registerLayoutCommands(commands, dispatch), [commands, dispatch]);
    const importedThemes = useImportedThemes();
    const importerOn = useExtensionOn(THEME_IMPORTER_ID);
    useEffect(
        () => registerThemeCommands(commands, switchTheme, importedThemes, importerOn && window.veraDesktop !== undefined ? importFromCommand : undefined),
        [commands, importedThemes, importerOn],
    );
    useEffect(() => registerSessionCommands(commands), [commands]);
    useEffect(() => registerOverlayCommands(commands), [commands]);

    // Native menu items and shortcuts arrive as command events. A hidden command has no menu item,
    // so one that arrives is a shortcut for a part that is off.
    useEffect(() => window.veraDesktop?.onEvent((event) => {
        if (event.type === "command" && !commands.isHidden(event.id)) commands.execute(event.id);
    }), [commands]);

    const run = useCallback((command: string, args?: unknown): void => {
        commands.execute(command, args);
    }, [commands]);

    return { loaded, layout, dispatch, run, commands };
}
