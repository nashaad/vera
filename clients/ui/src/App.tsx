import { useEffect, useMemo, useState } from "react";

import { BrowserSync } from "./browser/BrowserSync.tsx";
import { BrowserToolsStatus } from "./browser/BrowserToolsNotice.tsx";
import { recordVisit } from "./browser/history.ts";
import { recordRecent } from "./browser/recents.ts";
import { ChatCommands } from "./chat/ChatCommands.tsx";
import { ChatSync } from "./chat/ChatSync.tsx";
import { PageCommands } from "./commands/PageCommands.tsx";
import { SessionWindowCommands } from "./commands/SessionWindowCommands.tsx";
import { HostBanner } from "./components/HostBanner.tsx";
import { useLayout } from "./layout/useLayout.ts";
import { PageLinksProvider } from "./pagepane/PageLinks.tsx";
import { PagePaneSync } from "./pagepane/PagePaneSync.tsx";
import { useAnnexPanes } from "./pagepane/useAnnexPanes.ts";
import { Overlays } from "./overlays/Overlays.tsx";
import { ProviderWizard } from "./pages/settings/ProviderWizard.tsx";
import { RouterProvider } from "./pages/router.tsx";
import { SessionEvidenceReporter } from "./session/SessionEvidence.tsx";
import { SubagentCommands } from "./subagents/SubagentCommands.tsx";
import { SubagentsSync } from "./subagents/SubagentsSync.tsx";
import { bannerFor } from "./state/connection.ts";
import { OutputLog } from "./state/outputLog.ts";
import { hiddenCommands, unavailableContainers } from "./state/surfaces.ts";
import { useDesktopFlagsLoaded } from "./state/useDesktopFlags.ts";
import { useHostConnection } from "./state/useHostConnection.ts";
import { useVisibility, useWindowEvidence } from "./state/useSurfaces.ts";
import { ViewEnvContext } from "./views/env.tsx";
import { Workbench } from "./workbench/Workbench.tsx";
import { WorkbenchProvider } from "./workbench/WorkbenchProvider.tsx";

function reportTitleBarHeight(height: number): void {
    window.veraDesktop?.setTitleBarHeight(height);
}

export function App() {
    useEffect(() => window.veraDesktop?.onEvent((event) => {
        if (event.type === "browser_loaded") {
            recordRecent({ kind: "browser", target: event.url, title: event.title });
            recordVisit(event.url, event.title);
        }
    }), []);
    const [log] = useState(() => new OutputLog());
    const { state, reconnect, answer, refreshSessions, dismissInstallNotice } = useHostConnection(log);
    useWindowEvidence(state, log);
    const visible = useVisibility();
    const unavailable = useMemo(() => unavailableContainers(visible), [visible]);
    const { annex, kinds: pageKinds } = useAnnexPanes(state.phase === "attached" ? state.ready : undefined);
    const { loaded: layoutLoaded, layout, dispatch, run, commands } = useLayout(unavailable, pageKinds);
    const rightPaneEmpty = layout.locations.rightPane.all.length === 0;
    const panelEmpty = layout.locations.panel.all.length === 0;
    const hidden = useMemo(
        () => hiddenCommands(visible, { rightPane: rightPaneEmpty, panel: panelEmpty }),
        [visible, rightPaneEmpty, panelEmpty],
    );
    // The palette and slash menu read the registry; the shell rebuilds its menus from the same set.
    useEffect(() => {
        commands.setHidden(hidden);
        window.veraDesktop?.reportHiddenCommands([...hidden]);
    }, [commands, hidden]);
    const flagsLoaded = useDesktopFlagsLoaded();
    const loaded = layoutLoaded && flagsLoaded;
    const environment = useMemo(() => ({ connection: state, log, refreshSessions }), [state, log, refreshSessions]);
    const platform = window.veraDesktop?.platform ?? "";

    const [firstRun, setFirstRun] = useState(false);
    useEffect(() => {
        const bridge = window.veraDesktop;
        if (state.phase !== "attached" || bridge === undefined) return;
        let live = true;
        void bridge.listProviders().then((result) => {
            if (live && result.ok && result.needsSetup) setFirstRun(true);
        });
        return () => { live = false; };
    }, [state.phase]);
    const banner = bannerFor(state);
    return (
        <WorkbenchProvider layout={layout} dispatch={dispatch} run={run} hidden={hidden}>
            <PageLinksProvider annex={annex}>
            <RouterProvider commands={commands}>
            <ViewEnvContext.Provider value={environment}>
                <div className="app" data-platform={platform} data-sessions={state.sessions}>
                    {loaded ? (
                        <Workbench
                            platform={platform}
                            banner={banner !== undefined ? (
                                <HostBanner banner={banner} onAnswer={answer} onReconnect={reconnect} onDismiss={dismissInstallNotice} />
                            ) : null}
                            {...(platform === "darwin" ? { onTitleBarHeight: reportTitleBarHeight } : {})}
                        />
                    ) : <div className="workbench" />}
                    <BrowserToolsStatus />
                    {firstRun ? <ProviderWizard onClose={() => setFirstRun(false)} /> : null}
                    <Overlays commands={commands} />
                    <SessionWindowCommands commands={commands} />
                    <PageCommands commands={commands} />
                    <ChatCommands commands={commands} />
                    <SubagentCommands commands={commands} />
                    {loaded ? <BrowserSync /> : null}
                    {loaded ? <ChatSync /> : null}
                    {loaded ? <SubagentsSync /> : null}
                    {loaded ? <PagePaneSync /> : null}
                    <SessionEvidenceReporter />
                </div>
            </ViewEnvContext.Provider>
            </RouterProvider>
            </PageLinksProvider>
        </WorkbenchProvider>
    );
}
