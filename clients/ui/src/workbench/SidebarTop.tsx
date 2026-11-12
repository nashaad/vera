import { HeaderToggle } from "../components/HeaderToggle.tsx";
import { HistoryButtons } from "../components/HistoryButtons.tsx";

// The top row of the sidebar: room for the window controls, the sidebar toggle, then back and forward.
export function SidebarTop() {
    return (
        <div className="sidebar-top">
            <HeaderToggle location="sidebar" />
            <span className="spacer" />
            <HistoryButtons />
        </div>
    );
}
