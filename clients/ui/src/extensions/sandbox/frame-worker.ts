import type { WorkerLink } from "../runtime.ts";

// Next to index.html in dist/renderer. Main's navigation guard allows exactly this URL as a child frame.
const FRAME_PAGE = "extension-frame.html";

// One hidden frame per extension. `sandbox` without allow-same-origin gives the frame an opaque origin, so
// the worker inside has no window, storage or bridge. Removing the frame ends the worker.
export function createFrameLink(extensionId: string, receive: (data: unknown) => void): WorkerLink {
    const channel = new MessageChannel();
    const port = channel.port1;
    port.onmessage = (event) => receive(event.data);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.hidden = true;
    frame.src = new URL(FRAME_PAGE, window.location.href).href;
    // The frame's script has run by the time `load` fires. The port waits for the worker to take it.
    frame.addEventListener("load", () => {
        frame.contentWindow?.postMessage({ type: "start", extensionId }, "*", [channel.port2]);
    }, { once: true });
    document.body.append(frame);
    return {
        post: (message) => port.postMessage(message),
        terminate: () => {
            port.onmessage = null;
            port.close();
            frame.remove();
        },
    };
}
