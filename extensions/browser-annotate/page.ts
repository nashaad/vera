import { buildTextBlock, canAddAnnotation, clipRect, describeSelection } from "./helpers.ts";
import type { AnnotationResult, SelectionDetails } from "./helpers.ts";
import { hitDrawing, translateDrawing } from "./geometry.ts";
import type { Drawing, Point } from "./geometry.ts";

interface Snapshot {
    readonly drawings: readonly Drawing[];
}

const DRAWING_LIMIT = 200;
const HISTORY_LIMIT = 100;
const DRAWING_BOUNDS_LIMIT = 4096;
function annotatePage(): Promise<AnnotationResult | null> {
    return new Promise((resolve) => {
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
            .toolbar{position:fixed;z-index:2147483647;pointer-events:auto;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:3px;padding:5px;max-width:calc(100vw - 16px);width:max-content;flex-wrap:wrap;background:var(--annotation-surface);border:1px solid var(--annotation-border);border-radius:18px;box-shadow:var(--annotation-shadow)}
            button{font:inherit;color:var(--annotation-text);background:transparent;border:0;border-radius:7px;min-width:32px;height:32px;padding:0 8px;cursor:pointer}
            button svg{width:17px;height:17px;display:block;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
            button:focus-visible,input:focus-visible{outline:2px solid var(--annotation-focus);outline-offset:2px}
            .shape-wrap{position:relative}.shape-menu{position:absolute;bottom:40px;left:0;min-width:150px;padding:4px;background:var(--annotation-surface);border:1px solid var(--annotation-border);border-radius:8px;box-shadow:var(--annotation-shadow)}
            .shape-menu[hidden],.options[hidden],.action-group[hidden],button[hidden]{display:none}.shape-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left}.shape-menu button span{flex:1}.shape-menu button b{font-weight:normal}.shape-menu button[aria-checked=false] b:last-child{visibility:hidden}
            .options,.action-group{display:flex;align-items:center;gap:3px}
            button:hover,button[aria-pressed=true]{background:var(--annotation-surface-hover)}
            button.primary{color:var(--annotation-accent-text);background:var(--annotation-accent)}
            .divider{width:1px;height:22px;background:var(--annotation-border);margin:0 2px}
            select,input{font:inherit;color:inherit;border:1px solid var(--annotation-border-input);border-radius:var(--annotation-radius);background:var(--annotation-surface-input);height:30px}
            input[type=color]{width:32px;padding:2px} input[type=range]{width:64px}
            .text-entry{position:fixed;z-index:2147483647;pointer-events:auto;width:180px;padding:6px}
            .text-entry[hidden]{display:none}
            canvas{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none}
            .hover{position:fixed;pointer-events:none;border:1px solid var(--annotation-focus);background:color-mix(in srgb,var(--annotation-focus) 6%,transparent);z-index:2147483646}
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

        let mode: Drawing["kind"] | "select" | "move" = "select";
        let selected: Element | undefined;
        let color = getComputedStyle(host).getPropertyValue("--annotation-accent").trim();
        let width = 3;
        let drawing: Drawing | undefined;
        let moving: { index: number; start: Point; dx: number; dy: number } | undefined;
        let closed = false;
        let capturing = false;
        let deliver = resolve;
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
            for (const [index, item] of drawings.entries()) {
                context.save();
                if (moving?.index === index) context.translate(moving.dx, moving.dy);
                paint(context, item, ink);
                context.restore();
            }
            if (drawing !== undefined) paint(context, drawing, ink);
        };
        const setMode = (next: typeof mode): void => {
            if (next !== "text") addText();
            moving = undefined;
            mode = next;
            for (const button of Array.from(toolbar.querySelectorAll("button[data-mode]"))) {
                button.setAttribute("aria-pressed", String(button.getAttribute("data-mode") === next));
            }
            shapes.setAttribute("aria-pressed", String(["line", "arrow", "rectangle", "ellipse", "step"].includes(next)));
            document.documentElement.style.cursor = next === "move" ? "default" : "crosshair";
            syncAddButton();
        };
        const icons: Record<string, string> = {
            "Select element": "<path d='M4 3l11 8-5 1-2 5z'/>",
            Move: "<path d='M9 2v14M2 9h14M6 5l3-3 3 3M6 13l3 3 3-3M5 6L2 9l3 3M13 6l3 3-3 3'/>",
            Pen: "<path d='M4 14l1-4 8-8 3 3-8 8zM11 4l3 3'/>",
            Shapes: "<rect x='3' y='3' width='9' height='9' rx='1'/><circle cx='13' cy='13' r='4'/>",
            Text: "<path d='M3 4h12M9 4v12M6 16h6'/>",
            Undo: "<path d='M7 5L3 9l4 4M3 9h8a4 4 0 010 8'/>",
            Redo: "<path d='M11 5l4 4-4 4M15 9H7a4 4 0 000 8'/>",
            Clear: "<path d='M4 5h10M7 5V3h4v2M5 5l1 11h6l1-11'/>",
            Close: "<path d='M4 4l10 10M14 4L4 14'/>",
        };
        const button = (label: string, action: () => void, dataMode?: string): HTMLButtonElement => {
            const element = document.createElement("button");
            element.type = "button";
            if (icons[label] === undefined) element.textContent = label;
            else element.innerHTML = `<svg viewBox="0 0 18 18" aria-hidden="true">${icons[label]}</svg>`;
            element.title = label;
            element.setAttribute("aria-label", label);
            if (dataMode !== undefined) {
                element.dataset.mode = dataMode;
                element.setAttribute("aria-pressed", "false");
            }
            element.addEventListener("click", action);
            return element;
        };
        toolbar.append(
            button("Select element", () => setMode("select"), "select"),
            button("Move", () => setMode("move"), "move"),
            button("Pen", () => setMode("pen"), "pen"),
        );
        const shapeWrap = document.createElement("div");
        shapeWrap.className = "shape-wrap";
        const shapeMenu = document.createElement("div");
        shapeMenu.className = "shape-menu";
        shapeMenu.hidden = true;
        const shapes = button("Shapes", () => {
            shapeMenu.hidden = !shapeMenu.hidden;
            shapes.setAttribute("aria-expanded", String(!shapeMenu.hidden));
        });
        shapes.setAttribute("aria-expanded", "false");
        shapes.setAttribute("aria-haspopup", "menu");
        shapeMenu.setAttribute("role", "menu");
        for (const [shape, symbol] of [["Line", "╱"], ["Arrow", "↗"], ["Rectangle", "□"], ["Ellipse", "○"], ["Step", "①"]] as const) {
            const option = button(shape, () => {
                setMode(shape.toLowerCase() as Drawing["kind"]);
                for (const item of Array.from(shapeMenu.querySelectorAll("button"))) item.setAttribute("aria-checked", String(item === option));
                shapeMenu.hidden = true;
                shapes.setAttribute("aria-expanded", "false");
            });
            option.setAttribute("role", "menuitemradio");
            option.setAttribute("aria-checked", "false");
            option.innerHTML = `<b aria-hidden="true">${symbol}</b><span>${shape}</span><b aria-hidden="true">✓</b>`;
            shapeMenu.append(option);
        }
        shapeWrap.append(shapes, shapeMenu);
        toolbar.append(shapeWrap, button("Text", () => setMode("text"), "text"));
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.value = color;
        colorInput.title = "Color";
        colorInput.setAttribute("aria-label", "Color");
        colorInput.addEventListener("input", () => color = colorInput.value);
        const widthInput = document.createElement("input");
        widthInput.type = "range";
        widthInput.min = "1";
        widthInput.max = "12";
        widthInput.value = String(width);
        widthInput.title = "Width";
        widthInput.setAttribute("aria-label", "Width");
        widthInput.addEventListener("input", () => width = Number(widthInput.value));
        const divider = (): HTMLSpanElement => {
            const element = document.createElement("span");
            element.className = "divider";
            return element;
        };
        const options = document.createElement("span");
        options.className = "options";
        options.append(divider(), colorInput, widthInput);
        toolbar.append(options);
        const addToChat = button("Add to chat", () => finish(true));
        addToChat.className = "primary";
        const actions = document.createElement("span");
        actions.className = "action-group";
        const syncAddButton = (): void => {
            const available = canAddAnnotation(selected !== undefined, drawings.length) || (!textInput.hidden && textInput.value.length > 0 && drawings.length < DRAWING_LIMIT);
            addToChat.disabled = !available;
            addToChat.hidden = !available;
            options.hidden = mode === "select" || mode === "move";
            actions.hidden = mode === "select" && drawings.length === 0;
        };
        actions.append(
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
        );
        toolbar.append(actions, divider(), addToChat, button("Close", () => finish(false)));
        syncAddButton();

        const path = (event: MouseEvent): { x: number; y: number } => ({ x: event.clientX, y: event.clientY });
        const isOverlayEvent = (event: Event): boolean => {
            const path = event.composedPath();
            return path.includes(toolbar) || path.includes(textInput);
        };
        const addText = (): void => {
            if (textInput.hidden) return;
            const label = textInput.value.slice(0, 500);
            textInput.value = "";
            textInput.hidden = true;
            if (label.length > 0 && drawings.length < DRAWING_LIMIT) {
                keep();
                drawings.push({ kind: "text", points: [textPosition], color, width, label });
                syncAddButton();
                render();
            }
            syncAddButton();
        };
        textInput.maxLength = 500;
        textInput.addEventListener("input", syncAddButton);
        textInput.addEventListener("blur", addText);
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
            if (closed || capturing || isOverlayEvent(event)) return;
            if (mode === "select" && selected === undefined) {
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
            if (moving !== undefined) {
                moving.dx = event.clientX - moving.start.x;
                moving.dy = event.clientY - moving.start.y;
                render();
            }
            if (drawing !== undefined) {
                drawing = { ...drawing, points: [...drawing.points, path(event)].slice(-DRAWING_BOUNDS_LIMIT) };
                render();
            }
        };
        const onDown = (event: MouseEvent): void => {
            if (closed || capturing || isOverlayEvent(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!textInput.hidden) {
                addText();
                return;
            }
            if (mode === "move") {
                const point = path(event);
                for (let index = drawings.length - 1; index >= 0; index--) {
                    const item = drawings[index]!;
                    if (hitDrawing(item, point, (text) => {
                        if (context === null) return 0;
                        context.font = `${Math.max(12, text.width * 5)}px sans-serif`;
                        return context.measureText(text.label ?? "").width;
                    })) {
                        moving = { index, start: point, dx: 0, dy: 0 };
                        break;
                    }
                }
                return;
            }
            if (mode === "select") {
                event.preventDefault();
                event.stopImmediatePropagation();
                const target = document.elementFromPoint(event.clientX, event.clientY);
                if (target !== null && target !== host && !host.contains(target)) {
                    selected = target;
                    syncAddButton();
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
            if (moving !== undefined) {
                const { index, dx, dy } = moving;
                moving = undefined;
                if (dx !== 0 || dy !== 0) {
                    keep();
                    drawings[index] = translateDrawing(drawings[index]!, dx, dy);
                }
                render();
            }
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
            if (closed || capturing || isOverlayEvent(event)) return;
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
        const refreshSelection = (): void => {
            if (selected === undefined || capturing || closed) return;
            const rect = selected.getBoundingClientRect();
            hover.style.left = `${rect.left}px`;
            hover.style.top = `${rect.top}px`;
            hover.style.width = `${rect.width}px`;
            hover.style.height = `${rect.height}px`;
            tag.style.left = `${rect.left}px`;
            tag.style.top = `${Math.max(0, rect.top - 20)}px`;
        };
        const onResize = (): void => { resize(); refreshSelection(); };
        const cancelMove = (): void => {
            if (moving === undefined) return;
            moving = undefined;
            render();
        };
        const finish = async (add: boolean): Promise<void> => {
            if (closed) return;
            if (!add) {
                cleanup();
                return;
            }
            if (capturing) return;
            addText();
            capturing = true;
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
            } catch {
                toolbar.style.display = "flex";
                if (selected !== undefined) {
                    hover.style.display = "block";
                    tag.style.display = "block";
                }
                capturing = false;
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
            deliver(result);
        };
        const next = (): Promise<AnnotationResult | null> => {
            if (closed) return Promise.resolve(null);
            toolbar.style.display = "flex";
            if (selected !== undefined) {
                hover.style.display = "block";
                tag.style.display = "block";
            }
            capturing = false;
            refreshSelection();
            resultResolved = false;
            return new Promise((done) => { deliver = done; });
        };
        (globalThis as typeof globalThis & { __veraPageNext?: typeof next }).__veraPageNext = next;
        function stopListeners(): void {
            if (!listenersAttached) return;
            listenersAttached = false;
            window.removeEventListener("resize", onResize);
            window.removeEventListener("blur", cancelMove);
            document.removeEventListener("scroll", refreshSelection, true);
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
                deliver(null);
            }
            delete (globalThis as typeof globalThis & { __veraPageNext?: typeof next }).__veraPageNext;
        }
        (globalThis as typeof globalThis & { __veraPageCleanup?: () => void }).__veraPageCleanup = cleanup;
        window.addEventListener("resize", onResize);
        window.addEventListener("blur", cancelMove);
        document.addEventListener("scroll", refreshSelection, true);
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
