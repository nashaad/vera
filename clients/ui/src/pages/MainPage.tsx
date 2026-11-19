import { useSyncExternalStore } from "react";
import { draftCaptureOwner, subscribeDraftCaptureOwner } from "../composer/draft-capture-owner.ts";
import { CoveragePage } from "./CoveragePage.tsx";
import { CustomizePage } from "./CustomizePage.tsx";
import { DevicesPage } from "./DevicesPage.tsx";
import { ExtensionPage } from "./ExtensionPage.tsx";
import { HomePage } from "./HomePage.tsx";
import type { Route } from "./routes.ts";
import { SearchPage } from "./SearchPage.tsx";
import { SessionPage } from "./SessionPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { TourPage } from "./TourPage.tsx";
import { WorkPage } from "./WorkPage.tsx";
import { WorkspacePage } from "./WorkspacePage.tsx";
import { useTrackFinished } from "../state/finished.ts";

export interface MainPageProps {
    readonly route: Route;
    readonly platform: string;
}

export function MainPage({ route, platform }: MainPageProps) {
    useTrackFinished();
    const owner = useSyncExternalStore(subscribeDraftCaptureOwner, draftCaptureOwner);
    const ownerVisible = route.kind === "home" && (owner === undefined || route.folder === owner.folder);
    const showHome = route.kind === "home" || owner !== undefined;
    const folder = owner === undefined ? (route.kind === "home" ? route.folder : undefined) : owner.folder;
    return <>
        {showHome ? <div className="home-retained" hidden={!ownerVisible}><HomePage platform={platform} active={ownerVisible} captureOwner={owner} {...(folder === undefined ? {} : { folder })} /></div> : null}
        {route.kind === "home" ? (ownerVisible ? null : <HomePage platform={platform} active {...(route.folder === undefined ? {} : { folder: route.folder })} />) : <OtherPage route={route} />}
    </>;
}

function OtherPage({ route }: { readonly route: Exclude<Route, { readonly kind: "home" }> }) {
    switch (route.kind) {
        case "work":
            return <WorkPage />;
        case "session":
            return <SessionPage key={route.agentId} route={route} />;
        case "search":
            return <SearchPage />;
        case "workspace":
            return <WorkspacePage key={route.folder} route={route} />;
        case "devices":
            return <DevicesPage />;
        case "customize":
            return <CustomizePage />;
        case "settings":
            return <SettingsPage />;
        case "tour":
            return <TourPage />;
        case "coverage":
            return <CoveragePage />;
        case "extension":
            return <ExtensionPage key={route.path} route={route} />;
    }
}
