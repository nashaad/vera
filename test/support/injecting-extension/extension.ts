// Puts a fixed head above every message and declares its length, so a test can
// check that the band shows the user's words alone while the model receives
// both.

const HEAD = "<system-note>\nambient fact\n</system-note>\n\n";

export function activateClient(vera: any): void {
    vera.messages.intercept((message: { text: string }) => ({
        kind: "replace",
        text: `${HEAD}${message.text}`,
        injectedPrefix: HEAD.length,
    }));
}
