import { useState } from "react";

import { ConnectionPanel } from "./components/ConnectionPanel.tsx";
import { HostBanner } from "./components/HostBanner.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { bannerFor } from "./state/connection.ts";
import { useHostConnection } from "./state/useHostConnection.ts";
import { activateTheme } from "./theme/activate.ts";
import { readStoredTheme, storeTheme } from "./theme/storage.ts";
import { THEME_NAMES, type ThemeName } from "./theme/tokens.ts";

function reportTitleBarHeight(height: number): void {
    window.veraDesktop?.setTitleBarHeight(height);
}

export function App() {
    const { state, reconnect, answer } = useHostConnection();
    const [theme, setTheme] = useState<ThemeName>(() => readStoredTheme());

    const changeTheme = (name: ThemeName): void => {
        activateTheme(name);
        storeTheme(name);
        setTheme(name);
    };

    const banner = bannerFor(state);
    return (
        <div className="app">
            {window.veraDesktop?.platform === "darwin" ? (
                <TitleBar onHeight={reportTitleBarHeight} />
            ) : null}
            {banner !== undefined ? (
                <HostBanner banner={banner} onAnswer={answer} onReconnect={reconnect} />
            ) : null}
            <main className="main">
                <ConnectionPanel state={state} />
            </main>
            <StatusBar
                state={state}
                theme={theme}
                themeNames={THEME_NAMES}
                onThemeChange={changeTheme}
            />
        </div>
    );
}
