import { useMemo, useState } from "react";

import { PageCommands } from "./commands/PageCommands.tsx";
import { SessionWindowCommands } from "./commands/SessionWindowCommands.tsx";
import { HostBanner } from "./components/HostBanner.tsx";
import { useLayout } from "./layout/useLayout.ts";
import { Overlays } from "./overlays/Overlays.tsx";
import { RouterProvider } from "./pages/router.tsx";
import { bannerFor } from "./state/connection.ts";
import { OutputLog } from "./state/outputLog.ts";
import { useDesktopFlagsLoaded } from "./state/useDesktopFlags.ts";
import { useHostConnection } from "./state/useHostConnection.ts";
import { ViewEnvContext } from "./views/env.tsx";
import { Workbench } from "./workbench/Workbench.tsx";
import { WorkbenchProvider } from "./workbench/WorkbenchProvider.tsx";

function reportTitleBarHeight(height: number): void {
    window.veraDesktop?.setTitleBarHeight(height);
}

export function App() {
    const [log] = useState(() => new OutputLog());
    const { state, reconnect, answer } = useHostConnection(log);
    const { loaded: layoutLoaded, layout, dispatch, run, commands } = useLayout();
    const flagsLoaded = useDesktopFlagsLoaded();
    const loaded = layoutLoaded && flagsLoaded;
    const environment = useMemo(() => ({ connection: state, log }), [state, log]);
    const platform = window.veraDesktop?.platform ?? "";

    const banner = bannerFor(state);
    return (
        <WorkbenchProvider layout={layout} dispatch={dispatch} run={run}>
            <RouterProvider commands={commands}>
            <ViewEnvContext.Provider value={environment}>
                <div className="app" data-platform={platform} data-sessions={state.sessions}>
                    {loaded ? (
                        <Workbench
                            platform={platform}
                            banner={banner !== undefined ? (
                                <HostBanner banner={banner} onAnswer={answer} onReconnect={reconnect} />
                            ) : null}
                            {...(platform === "darwin" ? { onTitleBarHeight: reportTitleBarHeight } : {})}
                        />
                    ) : <div className="workbench" />}
                    <Overlays commands={commands} />
                    <SessionWindowCommands commands={commands} />
                    <PageCommands commands={commands} />
                </div>
            </ViewEnvContext.Provider>
            </RouterProvider>
        </WorkbenchProvider>
    );
}
