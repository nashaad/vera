import { HeaderToggle } from "../components/HeaderToggle.tsx";

// The top row of the sidebar: room for the window controls, then the sidebar toggle.
export function SidebarTop() {
    return (
        <div className="sidebar-top">
            <HeaderToggle location="sidebar" />
        </div>
    );
}
