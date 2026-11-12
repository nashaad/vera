import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { CommandRegistry } from "../commands/registry.ts";
import { registerLayoutCommands } from "../commands/layout-commands.ts";
import { registerOverlayCommands } from "../commands/overlay-commands.ts";
import { registerSessionCommands } from "../commands/session-commands.ts";
import { registerThemeCommands } from "../commands/theme-commands.ts";
import { ContributionRegistry } from "../registry/contributions.ts";
import { registerCoreContributions } from "../registry/core.ts";
import { switchTheme } from "../theme/activate.ts";
import { defaultLayout, type LayoutState } from "./model.ts";
import { createLayoutSaver } from "./persist.ts";
import { reduceLayout, type LayoutAction } from "./reducer.ts";
import { resolveLayout, type ResolvedLayout } from "./resolve.ts";

const SAVE_DELAY_MS = 400;

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

export function useLayout(): LayoutController {
    const [services] = useState(createServices);
    const { contributions, commands } = services;
    const [state, setState] = useState<LayoutState>(defaultLayout);
    const [loaded, setLoaded] = useState(false);
    // The state that came from disk or the last save, so loading alone never writes.
    const baseline = useRef<LayoutState>(state);
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
        saver.schedule(state);
    }, [loaded, state, saver]);

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
    useEffect(() => registerThemeCommands(commands, switchTheme), [commands]);
    useEffect(() => registerSessionCommands(commands), [commands]);
    useEffect(() => registerOverlayCommands(commands), [commands]);

    // Native menu items and shortcuts arrive as command events.
    useEffect(() => window.veraDesktop?.onEvent((event) => {
        if (event.type === "command") commands.execute(event.id);
    }), [commands]);

    const run = useCallback((command: string, args?: unknown): void => {
        commands.execute(command, args);
    }, [commands]);

    return { loaded, layout, dispatch, run, commands };
}
