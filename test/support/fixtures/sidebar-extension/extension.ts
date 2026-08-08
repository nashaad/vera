export function activateClient(vera: any): void {
    vera.commands.register({
        name: "pane",
        description: "Open the sidebar and write a block into it",
        usage: "/pane",
        run() {
            vera.ui.sidebar.open("Seats");
            vera.ui.sidebar.append({
                label: "m1 (faux)",
                text: "beside the transcript",
            });
        },
    });
    vera.commands.register({
        name: "unpane",
        description: "Close the sidebar",
        usage: "/unpane",
        run() {
            vera.ui.sidebar.close();
        },
    });
}
