import type { ReactNode } from "react";

import { TitleBar } from "../components/TitleBar.tsx";
import { MainPage } from "../pages/MainPage.tsx";
import { useRouter } from "../pages/router.tsx";
import { routeTitle } from "../pages/routes.ts";
import { LOCATION_SIZES, MAIN_MIN_WIDTH, type LocationId } from "../layout/model.ts";
import { DropStrip } from "./DropStrip.tsx";
import { useIsShown, useWorkbench } from "./context.tsx";
import { LocationPane } from "./LocationPane.tsx";
import { Sash } from "./Sash.tsx";

function SizedSash({ location, direction }: { readonly location: LocationId; readonly direction: 1 | -1 }) {
    const { layout, dispatch } = useWorkbench();
    const { min, max, initial } = LOCATION_SIZES[location];
    return (
        <Sash
            orientation={location === "panel" ? "horizontal" : "vertical"}
            label={location}
            value={layout.locations[location].size}
            min={min}
            max={max}
            direction={direction}
            onResize={(size) => dispatch({ type: "resizeLocation", location, size })}
            onReset={() => dispatch({ type: "resizeLocation", location, size: initial })}
        />
    );
}

export interface WorkbenchProps {
    readonly platform: string;
    // Drawn under the main header, above the main area.
    readonly banner?: ReactNode;
    readonly onTitleBarHeight?: (height: number) => void;
}

export function Workbench({ platform, banner, onTitleBarHeight }: WorkbenchProps) {
    const sidebar = useIsShown("sidebar");
    const rightPane = useIsShown("rightPane");
    const panel = useIsShown("panel");
    const { route } = useRouter();
    return (
        <div className="workbench">
            {sidebar ? (
                <>
                    <LocationPane location="sidebar" />
                    <SizedSash location="sidebar" direction={1} />
                </>
            ) : (
                <DropStrip location="sidebar" />
            )}
            <div className="stage" style={{ minWidth: MAIN_MIN_WIDTH }}>
                <TitleBar
                    title={routeTitle(route)}
                    sidebarShown={sidebar}
                    {...(onTitleBarHeight === undefined ? {} : { onHeight: onTitleBarHeight })}
                />
                {banner}
                <div className="stage-body">
                    <div className="center" style={{ minWidth: MAIN_MIN_WIDTH }}>
                        <main className="main" aria-label="Main" data-page={route.kind}>
                            <MainPage route={route} platform={platform} />
                        </main>
                        {panel ? (
                            <>
                                <SizedSash location="panel" direction={-1} />
                                <LocationPane location="panel" />
                            </>
                        ) : (
                            <DropStrip location="panel" />
                        )}
                    </div>
                    {rightPane ? null : <DropStrip location="rightPane" />}
                </div>
            </div>
            {rightPane ? (
                <>
                    <SizedSash location="rightPane" direction={-1} />
                    <LocationPane location="rightPane" />
                </>
            ) : null}
        </div>
    );
}
