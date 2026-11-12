import { BlocksIcon, GearIcon, SearchIcon } from "../components/Icons.tsx";
import { HomePage } from "./HomePage.tsx";
import { EmptyState, Page } from "./Page.tsx";
import type { Route } from "./routes.ts";
import { SessionPage } from "./SessionPage.tsx";
import { WorkPage } from "./WorkPage.tsx";

export interface MainPageProps {
    readonly route: Route;
    readonly platform: string;
}

export function MainPage({ route, platform }: MainPageProps) {
    switch (route.kind) {
        case "home":
            return <HomePage platform={platform} />;
        case "work":
            return <WorkPage />;
        case "session":
            return <SessionPage key={route.agentId} route={route} />;
        case "search":
            return (
                <Page title="Search" lede="Find a session by its title or by what was said in it." Icon={SearchIcon}>
                    <EmptyState title="Search is not connected yet">This build lists sessions in the sidebar only.</EmptyState>
                </Page>
            );
        case "customize":
            return (
                <Page title="Customize" lede="Skills, agents and the places Vera loads them from." Icon={BlocksIcon}>
                    <EmptyState title="Nothing to show yet">This build does not read the home's customizations.</EmptyState>
                </Page>
            );
        case "settings":
            return (
                <Page title="Settings" lede="How this window looks and behaves." Icon={GearIcon}>
                    <EmptyState title="Nothing to set yet">The theme is chosen from the View menu.</EmptyState>
                </Page>
            );
    }
}
