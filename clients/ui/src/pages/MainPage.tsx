import { CoveragePage } from "./CoveragePage.tsx";
import { CustomizePage } from "./CustomizePage.tsx";
import { DevicesPage } from "./DevicesPage.tsx";
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
    switch (route.kind) {
        case "home":
            return <HomePage platform={platform} {...(route.folder === undefined ? {} : { folder: route.folder })} />;
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
    }
}
