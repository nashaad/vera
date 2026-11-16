import { buildTextBlock, canAddAnnotation, clipRect, describeSelection } from "./helpers.ts";
import type { AnnotationResult, SelectionDetails } from "./helpers.ts";

interface Drawing {
    readonly kind: "pen" | "line" | "arrow" | "rectangle" | "ellipse" | "step" | "text";
    readonly points: readonly { readonly x: number; readonly y: number }[];
    readonly color: string;
    readonly width: number;
    readonly label?: string;
    readonly number?: number;
}

interface Snapshot {
    readonly drawings: readonly Drawing[];
}

const DRAWING_LIMIT = 200;
const HISTORY_LIMIT = 100;
const DRAWING_BOUNDS_LIMIT = 4096;
function annotatePage(): Promise<AnnotationResult | null> {
    return new Promise((resolve, reject) => {
        const existing = (globalThis as typeof globalThis & { __veraPageCleanup?: () => void }).__veraPageCleanup;
        existing?.();
        const host = document.createElement("div");
        host.setAttribute("data-vera-annotation", "");
        const shadow = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        // Values mirror clients/ui/src/theme/themes/dark.json and clients/ui/src/styles/base.css.
        style.textContent = `
            :host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;--annotation-accent:#e8582a!important;--annotation-focus:#7f9ff0!important;--annotation-ink:#000!important;--annotation-text:#e6e6e6!important;--annotation-surface:#131313!important;--annotation-border:#262626!important;--annotation-radius:7px!important;--annotation-surface-hover:#1e1e1e!important;--annotation-accent-text:#000!important;--annotation-border-input:#343434!important;--annotation-surface-input:#0f0f0f!important;--annotation-radius-sm:5px!important;--annotation-font-size:13px!important;--annotation-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif!important;--annotation-shadow:0 12px 34px rgba(0,0,0,.62),0 0 0 1px rgba(255,255,255,.05)!important;color:var(--annotation-text)!important;font:var(--annotation-font-size) var(--annotation-font)!important;color-scheme:dark!important}
            *{box-sizing:border-box}
            .toolbar{position:fixed;z-index:2147483647;pointer-events:auto;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;justify-content:center;gap:4px;padding:6px;max-width:calc(100vw - 16px);width:max-content;flex-wrap:wrap;background:var(--annotation-surface);border:1px solid var(--annotation-border);border-radius:var(--annotation-radius);box-shadow:var(--annotation-shadow);white-space:normal}
            button{font:inherit;color:var(--annotation-text);background:transparent;border:0;border-radius:var(--annotation-radius);padding:7px 9px;cursor:pointer}
            button:hover,button[aria-pressed=true]{background:var(--annotation-surface-hover)}
            button.primary{color:var(--annotation-accent-text);background:var(--annotation-accent)}
            .divider{width:1px;height:22px;background:var(--annotation-border);margin:0 2px}
            select,input{font:inherit;color:inherit;border:1px solid var(--annotation-border-input);border-radius:var(--annotation-radius);background:var(--annotation-surface-input);height:30px}
            input[type=color]{width:32px;padding:2px} input[type=range]{width:64px}
            .text-entry{position:fixed;z-index:2147483647;pointer-events:auto;width:180px;padding:6px}
            .text-entry[hidden]{display:none}
            canvas{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none}
            .hover{position:fixed;pointer-events:none;border:2px solid var(--annotation-focus);background:color-mix(in srgb,var(--annotation-focus) 10%,transparent);z-index:2147483646}
            .tag{position:fixed;pointer-events:none;background:var(--annotation-focus);color:var(--annotation-ink);padding:2px 5px;border-radius:var(--annotation-radius-sm);font:12px var(--annotation-font);z-index:2147483647}
        `;
        shadow.append(style);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        const hover = document.createElement("div");
        hover.className = "hover";
        const tag = document.createElement("div");
        tag.className = "tag";
        const toolbar = document.createElement("div");
        toolbar.className = "toolbar";
        toolbar.setAttribute("role", "toolbar");
        const textInput = document.createElement("input");
        textInput.className = "text-entry";
        textInput.type = "text";
        textInput.setAttribute("aria-label", "Text");
        textInput.hidden = true;
        shadow.append(canvas, hover, tag, toolbar, textInput);
        document.documentElement.append(host);

        let mode: Drawing["kind"] | "select" = "select";
        let selected: Element | undefined;
        let color = getComputedStyle(host).getPropertyValue("--annotation-accent").trim();
        let width = 3;
        let drawing: Drawing | undefined;
        let closed = false;
        let resultResolved = false;
        let listenersAttached = true;
        let count = 0;
        let textPosition = { x: 0, y: 0 };
        const originalCursor = document.documentElement.style.getPropertyValue("cursor");
        const originalCursorPriority = document.documentElement.style.getPropertyPriority("cursor");
        const undo: Snapshot[] = [];
        const redo: Snapshot[] = [];
        const drawings: Drawing[] = [];
        const dimensions = (): { width: number; height: number; scale: number } => ({
            width: window.innerWidth,
            height: window.innerHeight,
            scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
        });
        const resize = (): void => {
            const view = dimensions();
            canvas.width = Math.min(view.width * view.scale, DRAWING_BOUNDS_LIMIT);
            canvas.height = Math.min(view.height * view.scale, DRAWING_BOUNDS_LIMIT);
            canvas.style.width = `${view.width}px`;
            canvas.style.height = `${view.height}px`;
            render();
        };
        const keep = (): void => {
            undo.push({ drawings: drawings.slice() });
            if (undo.length > HISTORY_LIMIT) undo.shift();
            redo.length = 0;
        };
        const render = (): void => {
            if (context === null) return;
            const view = dimensions();
            context.setTransform(canvas.width / view.width, 0, 0, canvas.height / view.height, 0, 0);
            context.clearRect(0, 0, view.width, view.height);
            const ink = getComputedStyle(host).getPropertyValue("--annotation-ink").trim();
            for (const item of drawings) paint(context, item, ink);
            if (drawing !== undefined) paint(context, drawing, ink);
        };
        const setMode = (next: typeof mode): void => {
            mode = next;
            if (next !== "text") textInput.hidden = true;
            for (const button of Array.from(toolbar.querySelectorAll("button[data-mode]"))) {
                button.setAttribute("aria-pressed", String(button.getAttribute("data-mode") === next));
            }
            document.documentElement.style.cursor = next === "select" ? "crosshair" : "crosshair";
        };
        const button = (label: string, action: () => void, dataMode?: string): HTMLButtonElement => {
            const element = document.createElement("button");
            element.type = "button";
            element.textContent = label;
            element.title = label;
            if (dataMode !== undefined) {
                element.dataset.mode = dataMode;
                element.setAttribute("aria-pressed", "false");
            }
            element.addEventListener("click", action);
            return element;
        };
        toolbar.append(
            button("Select element", () => setMode("select"), "select"),
            button("Pen", () => setMode("pen"), "pen"),
        );
        const shapes = document.createElement("select");
        for (const shape of ["Line", "Arrow", "Rectangle", "Ellipse", "Step"] as const) {
            const option = document.createElement("option");
            option.value = shape.toLowerCase();
            option.textContent = shape;
            shapes.append(option);
        }
        shapes.setAttribute("aria-label", "Shapes");
        shapes.title = "Shapes";
        shapes.addEventListener("click", () => setMode(shapes.value as Drawing["kind"]));
        shapes.addEventListener("change", () => setMode(shapes.value as Drawing["kind"]));
        toolbar.append(shapes, button("Text", () => setMode("text"), "text"));
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.value = color;
        colorInput.title = "Color";
        colorInput.addEventListener("input", () => color = colorInput.value);
        const widthInput = document.createElement("input");
        widthInput.type = "range";
        widthInput.min = "1";
        widthInput.max = "12";
        widthInput.value = String(width);
        widthInput.title = "Width";
        widthInput.addEventListener("input", () => width = Number(widthInput.value));
        const divider = (): HTMLSpanElement => {
            const element = document.createElement("span");
            element.className = "divider";
            return element;
        };
        toolbar.append(colorInput, widthInput, divider());
        const addToChat = button("Add to chat", () => finish(true));
        addToChat.className = "primary";
        const syncAddButton = (): void => {
            addToChat.disabled = !canAddAnnotation(selected !== undefined, drawings.length);
        };
        syncAddButton();
        toolbar.append(
            button("Undo", () => {
                const snapshot = undo.pop();
                if (snapshot !== undefined) {
                    redo.push({ drawings: drawings.slice() });
                    drawings.splice(0, drawings.length, ...snapshot.drawings);
                    syncAddButton();
                    render();
                }
            }),
            button("Redo", () => {
                const snapshot = redo.pop();
                if (snapshot !== undefined) {
                    undo.push({ drawings: drawings.slice() });
                    if (undo.length > HISTORY_LIMIT) undo.shift();
                    drawings.splice(0, drawings.length, ...snapshot.drawings);
                    syncAddButton();
                    render();
                }
            }),
            button("Clear", () => {
                if (drawings.length === 0) return;
                keep();
                drawings.length = 0;
                syncAddButton();
                render();
            }),
            divider(),
            addToChat,
            button("Close", () => finish(false)),
        );

        const path = (event: MouseEvent): { x: number; y: number } => ({ x: event.clientX, y: event.clientY });
        const isOverlayEvent = (event: Event): boolean => {
            const path = event.composedPath();
            return path.includes(toolbar) || path.includes(textInput);
        };
        const addText = (): void => {
            const label = textInput.value.slice(0, 500);
            if (label.length > 0 && drawings.length < DRAWING_LIMIT) {
                keep();
                drawings.push({ kind: "text", points: [textPosition], color, width, label });
                syncAddButton();
                render();
            }
            textInput.value = "";
            textInput.hidden = true;
        };
        textInput.addEventListener("keydown", (event) => {
            event.stopImmediatePropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                finish(false);
            } else if (event.key === "Enter") {
                event.preventDefault();
                addText();
            }
        });
        const onMove = (event: MouseEvent): void => {
            if (closed || isOverlayEvent(event)) return;
            if (mode === "select") {
                const target = document.elementFromPoint(event.clientX, event.clientY);
                if (target === null || target === host || host.contains(target)) return;
                const rect = target.getBoundingClientRect();
                hover.style.display = "block";
                hover.style.left = `${rect.left}px`;
                hover.style.top = `${rect.top}px`;
                hover.style.width = `${rect.width}px`;
                hover.style.height = `${rect.height}px`;
                tag.textContent = target.localName;
                tag.style.display = "block";
                tag.style.left = `${rect.left}px`;
                tag.style.top = `${Math.max(0, rect.top - 20)}px`;
            }
            if (drawing !== undefined) {
                drawing = { ...drawing, points: [...drawing.points, path(event)].slice(-DRAWING_BOUNDS_LIMIT) };
                render();
            }
        };
        const onDown = (event: MouseEvent): void => {
            if (closed || isOverlayEvent(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (mode === "select") {
                event.preventDefault();
                event.stopImmediatePropagation();
                const target = document.elementFromPoint(event.clientX, event.clientY);
                if (target !== null && target !== host && !host.contains(target)) {
                    selected = target;
                    syncAddButton();
                    hover.style.display = "none";
                    tag.style.display = "none";
                }
                return;
            }
            if (mode === "text") {
                textPosition = path(event);
                textInput.style.left = `${Math.max(0, Math.min(window.innerWidth - 190, event.clientX))}px`;
                textInput.style.top = `${Math.max(0, Math.min(window.innerHeight - 44, event.clientY))}px`;
                textInput.hidden = false;
                textInput.focus();
                return;
            }
            if (drawings.length >= DRAWING_LIMIT) return;
            if (mode === "step") count += 1;
            drawing = { kind: mode, points: [path(event)], color, width, ...(mode === "step" ? { number: count } : {}) };
        };
        const onUp = (): void => {
            if (drawing === undefined) return;
            if (drawings.length < DRAWING_LIMIT) {
                keep();
                drawings.push(drawing);
                syncAddButton();
            }
            drawing = undefined;
            render();
        };
        const onClick = (event: MouseEvent): void => {
            if (closed || isOverlayEvent(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                finish(false);
            }
        };
        const onResize = (): void => resize();
        const finish = async (add: boolean): Promise<void> => {
            if (closed) return;
            closed = true;
            stopListeners();
            if (!add) {
                cleanup();
                return;
            }
            hover.style.display = "none";
            tag.style.display = "none";
            toolbar.style.display = "none";
            textInput.hidden = true;
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            const box = selected?.getBoundingClientRect();
            const rect = box === undefined
                ? clipRect({ x: 0, y: 0, width: viewport.width, height: viewport.height }, viewport.width, viewport.height)
                : clipRect({ x: box.left, y: box.top, width: box.width, height: box.height }, viewport.width, viewport.height);
            let details: SelectionDetails | undefined;
            try {
                details = selected === undefined ? undefined : describeSelection(selected);
            } catch (error) {
                resultResolved = true;
                cleanup();
                reject(error);
                return;
            }
            const result: AnnotationResult = {
                rect,
                text: buildTextBlock(location.href, details),
                ...(details === undefined ? {} : { details }),
            };
            await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
            if (resultResolved) return;
            resultResolved = true;
            resolve(result);
        };
        function stopListeners(): void {
            if (!listenersAttached) return;
            listenersAttached = false;
            window.removeEventListener("resize", onResize);
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mousedown", onDown, true);
            document.removeEventListener("mouseup", onUp, true);
            document.removeEventListener("click", onClick, true);
            document.removeEventListener("keydown", onKey, true);
            if (originalCursor.length > 0) {
                document.documentElement.style.setProperty("cursor", originalCursor, originalCursorPriority);
            } else {
                document.documentElement.style.removeProperty("cursor");
            }
        }
        function cleanup(): void {
            closed = true;
            stopListeners();
            host.remove();
            if ((globalThis as typeof globalThis & { __veraPageCleanup?: () => void }).__veraPageCleanup === cleanup) {
                delete (globalThis as typeof globalThis & { __veraPageCleanup?: () => void }).__veraPageCleanup;
            }
            if (!resultResolved) {
                resultResolved = true;
                resolve(null);
            }
        }
        (globalThis as typeof globalThis & { __veraPageCleanup?: () => void }).__veraPageCleanup = cleanup;
        window.addEventListener("resize", onResize);
        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("mouseup", onUp, true);
        document.addEventListener("click", onClick, true);
        document.addEventListener("keydown", onKey, true);
        resize();
        setMode("select");
    });
}

function paint(context: CanvasRenderingContext2D, item: Drawing, ink: string): void {
    const [first, ...rest] = item.points;
    if (first === undefined) return;
    context.save();
    context.strokeStyle = item.color;
    context.fillStyle = item.color;
    context.lineWidth = item.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (item.kind === "text") {
        context.font = `${Math.max(12, item.width * 5)}px sans-serif`;
        context.fillText(item.label ?? "", first.x, first.y);
    } else if (item.kind === "pen") {
        context.beginPath();
        context.moveTo(first.x, first.y);
        for (const point of rest) context.lineTo(point.x, point.y);
        context.stroke();
    } else {
        const last = item.points[item.points.length - 1] ?? first;
        if (item.kind === "step") {
            context.beginPath();
            context.arc(first.x, first.y, 12, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = ink;
            context.font = "12px sans-serif";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(String(item.number ?? ""), first.x, first.y);
        } else if (item.kind === "line" || item.kind === "arrow") {
            context.beginPath();
            context.moveTo(first.x, first.y);
            context.lineTo(last.x, last.y);
            context.stroke();
            if (item.kind === "arrow") {
                const angle = Math.atan2(last.y - first.y, last.x - first.x);
                context.beginPath();
                context.moveTo(last.x, last.y);
                context.lineTo(last.x - 12 * Math.cos(angle - Math.PI / 6), last.y - 12 * Math.sin(angle - Math.PI / 6));
                context.lineTo(last.x - 12 * Math.cos(angle + Math.PI / 6), last.y - 12 * Math.sin(angle + Math.PI / 6));
                context.closePath();
                context.fill();
            }
        } else {
            const x = Math.min(first.x, last.x);
            const y = Math.min(first.y, last.y);
            const w = Math.abs(last.x - first.x);
            const h = Math.abs(last.y - first.y);
            context.beginPath();
            if (item.kind === "ellipse") context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            else context.rect(x, y, w, h);
            context.stroke();
        }
    }
    context.restore();
}

(globalThis as typeof globalThis & { __veraPageResult?: Promise<AnnotationResult | null> }).__veraPageResult = annotatePage();
