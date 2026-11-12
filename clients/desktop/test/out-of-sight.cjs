// Loaded with -r ahead of the app's main script, so every trial window is hidden from its first
// frame: transparent, no Dock icon, no focus and no mouse. The page still counts as shown, so it
// renders and Playwright input reaches it as usual.
const { app } = require("electron");

function hideFromDock() {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
}

hideFromDock();
app.on("will-finish-launching", hideFromDock);
app.on("ready", hideFromDock);

app.on("browser-window-created", (_event, window) => {
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
    window.setFocusable(false);
    // show() would bring the app forward on ready-to-show.
    window.show = () => window.showInactive();
    window.focus = () => {};
});
