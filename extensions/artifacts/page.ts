// Runs in the browser. The annex transpiles this file alone, so it imports nothing.

interface Block {
    readonly kind: string;
    readonly text: string;
    readonly html: string;
}

interface Comment {
    readonly id: string;
    readonly quote: string;
    readonly index: number;
    readonly body: string;
    readonly createdAt: string;
    readonly status: "open" | "closed";
    readonly closedAt?: string;
    readonly closedBy?: "agent" | "user";
    readonly sentAt?: string;
    readonly outdated: boolean;
    readonly blockIndex: number;
}

interface ArtifactState {
    readonly sessionId: string;
    readonly name: string;
    readonly title: string;
    readonly viewer: string;
    readonly exists: boolean;
    readonly updatedAt?: string;
    readonly blocks: readonly Block[];
    readonly comments: readonly Comment[];
    readonly version: string;
}

interface ArtifactSummary {
    readonly sessionId: string;
    readonly name: string;
    readonly title: string;
    readonly updatedAt: string;
    readonly openComments: number;
}

interface Draft {
    readonly quote: string;
    readonly index: number;
    text: string;
    send: boolean;
}

interface Context {
    readonly api: string;
    readonly page: string;
}

type CommentMode = "open" | "all" | "hidden";

const POLL_MS = 1000;
const EMBED_MAX_HEIGHT = 1200;
// Appended to each embed: reports its height, and follows the page's light or dark theme.
const EMBED_SHIM = `<style>:root{color-scheme:light dark}</style><script>(()=>{const post=()=>parent.postMessage({artifactsEmbedHeight:document.documentElement.scrollHeight},"*");new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);})();</script>`;
const STYLE_ID = "artifacts-page-style";
const MODE_KEY = "artifacts-comment-mode";

const ICON_COMMENT = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6a1.5 1.5 0 0 1-1.5 1.5H7.2L4 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5Z"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="m4 6 4 4 4-4"/></svg>`;
const ICON_SEND = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>`;

export function mount(root: HTMLElement, context: Context): () => void {
    installStyle();
    const params = new URLSearchParams(window.location.search);
    const session = params.get("session");
    const artifact = params.get("artifact");
    const view = session === null || artifact === null
        ? new ArtifactList(root, context)
        : new ArtifactView(root, context, session, artifact);
    view.start();
    return () => view.stop();
}

class ArtifactList {
    private timer: ReturnType<typeof setInterval> | undefined;
    private version = "";

    constructor(private readonly root: HTMLElement, private readonly context: Context) {}

    start(): void {
        void this.refresh(true);
        this.timer = setInterval(() => void this.refresh(), POLL_MS * 3);
    }

    stop(): void {
        clearInterval(this.timer);
    }

    private async refresh(force = false): Promise<void> {
        if (document.hidden && !force) return;
        const response = await fetch(`${this.context.api}artifacts`);
        if (!response.ok) return;
        const body = await response.json() as { artifacts: readonly ArtifactSummary[] };
        const version = JSON.stringify(body.artifacts);
        if (version === this.version) return;
        this.version = version;
        this.render(body.artifacts);
    }

    private render(artifacts: readonly ArtifactSummary[]): void {
        this.root.replaceChildren();
        const wrap = el("div", "artifacts");
        if (artifacts.length === 0) {
            wrap.append(el("p", "artifacts-empty", "No artifacts yet. An artifact appears here when an agent writes one with artifact_write."));
            this.root.append(wrap);
            return;
        }
        const list = el("div", "artifacts-list");
        for (const artifact of artifacts) {
            const row = el("a", "artifacts-row") as HTMLAnchorElement;
            row.href = artifactHref(this.context.page, artifact.sessionId, artifact.name);
            row.append(
                el("span", "artifacts-row-title", artifact.title),
                el("span", "artifacts-row-meta", [
                    artifact.name,
                    artifact.sessionId.slice(0, 8),
                    ago(artifact.updatedAt),
                    ...(artifact.openComments > 0 ? [`${artifact.openComments} open`] : []),
                ].join(" · ")),
            );
            list.append(row);
        }
        wrap.append(list);
        this.root.append(wrap);
    }
}

class ArtifactView {
    private timer: ReturnType<typeof setInterval> | undefined;
    private state: ArtifactState | undefined;
    private readonly drafts = new Map<string, Draft>();
    private readonly expanded = new Set<string>();
    // Why a comment the user asked to send did not reach the session. Kept until reload.
    private readonly unsent = new Map<string, string>();
    private failed = false;
    private mode: CommentMode = readMode();
    private menuOpen = false;
    private shownBlocks: string | undefined;
    private readonly closeMenu = (event: Event): void => {
        if (!this.menuOpen) return;
        if (event instanceof KeyboardEvent && event.key !== "Escape") return;
        if (event.target instanceof Node && this.root.querySelector(".artifacts-tools")?.contains(event.target)) return;
        this.menuOpen = false;
        this.render();
    };

    // Any embed can post this, so it only ever resizes the frame that sent it.
    private readonly onEmbedHeight = (event: MessageEvent): void => {
        const height = (event.data as { artifactsEmbedHeight?: unknown } | null)?.artifactsEmbedHeight;
        if (typeof height !== "number" || !Number.isFinite(height)) return;
        for (const frame of Array.from(this.root.querySelectorAll<HTMLIFrameElement>("iframe.pb-embed"))) {
            if (frame.contentWindow !== event.source) continue;
            frame.style.height = `${Math.min(Math.max(Math.ceil(height), 32), EMBED_MAX_HEIGHT)}px`;
        }
    };

    private readonly onVisible = (): void => {
        if (!document.hidden) void this.refresh();
    };

    constructor(
        private readonly root: HTMLElement,
        private readonly context: Context,
        private readonly session: string,
        private readonly artifact: string,
    ) {}

    start(): void {
        void this.refresh(true);
        this.timer = setInterval(() => void this.refresh(), POLL_MS);
        document.addEventListener("mousedown", this.closeMenu);
        document.addEventListener("keydown", this.closeMenu);
        document.addEventListener("visibilitychange", this.onVisible);
        window.addEventListener("message", this.onEmbedHeight);
    }

    stop(): void {
        clearInterval(this.timer);
        document.removeEventListener("mousedown", this.closeMenu);
        document.removeEventListener("keydown", this.closeMenu);
        document.removeEventListener("visibilitychange", this.onVisible);
        window.removeEventListener("message", this.onEmbedHeight);
    }

    private async refresh(force = false): Promise<void> {
        if (document.hidden && !force) return;
        try {
            const query = `session=${encodeURIComponent(this.session)}&artifact=${encodeURIComponent(this.artifact)}`;
            const response = await fetch(`${this.context.api}artifact?${query}`);
            if (!response.ok) throw new Error(String(response.status));
            const next = await response.json() as ArtifactState;
            const recovered = this.failed;
            this.failed = false;
            if (!force && !recovered && next.version === this.state?.version) return;
            this.state = next;
        } catch {
            if (this.failed) return;
            this.failed = true;
        }
        this.render();
    }

    private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await fetch(`${this.context.api}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: this.session, artifact: this.artifact, ...body }),
        });
        const reply = await response.json().catch(() => ({})) as Record<string, unknown>;
        await this.refresh(true);
        return reply;
    }

    private setMode(mode: CommentMode): void {
        this.mode = mode;
        this.menuOpen = false;
        writeMode(mode);
        this.render();
    }

    private render(): void {
        const focus = captureFocus();
        const state = this.state;
        const wrapClass = `artifacts artifacts-artifact${this.mode === "hidden" ? " artifacts-no-margin" : ""}`;
        const shown = state?.exists === true ? blocksKey(state.blocks) : undefined;
        const current = this.root.querySelector<HTMLElement>(":scope > .artifacts-artifact");
        const body = current?.querySelector<HTMLElement>(":scope > .artifacts-body");
        if (state !== undefined && shown !== undefined && shown === this.shownBlocks && current && body) {
            current.className = wrapClass;
            current.querySelector(":scope > .artifacts-head")?.replaceWith(this.header(state));
            this.patchDocument(body, state);
            restoreFocus(this.root, focus);
            return;
        }
        this.shownBlocks = shown;
        this.root.replaceChildren();
        const wrap = el("div", wrapClass);
        wrap.append(this.header(state));
        if (state === undefined) {
            wrap.append(el("p", "artifacts-empty", this.failed ? "Cannot reach the annex." : "Loading..."));
        } else if (!state.exists) {
            wrap.append(el("p", "artifacts-empty", `No artifact named ${this.artifact} yet. It appears here as soon as the agent writes it.`));
        } else {
            wrap.append(this.document(state));
        }
        this.root.append(wrap);
        restoreFocus(this.root, focus);
    }

    private header(state: ArtifactState | undefined): HTMLElement {
        const header = el("div", "artifacts-head");
        const crumbs = el("div", "artifacts-crumbs");
        const back = el("a", "artifacts-back", "Artifacts") as HTMLAnchorElement;
        back.href = this.context.page;
        crumbs.append(back, el("span", "artifacts-sep", "›"), el("span", "artifacts-name", state?.title ?? this.artifact));

        const open = state?.comments.filter((comment) => comment.status === "open").length ?? 0;
        const meta = el("div", "artifacts-meta");
        meta.append(
            el("span", this.failed ? "artifacts-live artifacts-live-off" : "artifacts-live", this.failed ? "offline" : "live"),
            el("span", "", [
                this.session.slice(0, 8),
                ...(state?.updatedAt === undefined ? [] : [`updated ${ago(state.updatedAt)}`]),
            ].join(" · ")),
        );

        header.append(crumbs, meta, this.tools(state?.viewer ?? "You", open));
        return header;
    }

    // Avatar plus a split button: the bubble toggles comments, the chevron picks which.
    private tools(viewer: string, open: number): HTMLElement {
        const tools = el("div", "artifacts-tools");
        tools.append(avatar(viewer));
        const split = el("div", "artifacts-split");
        const toggle = el("button", `artifacts-toggle${this.mode === "hidden" ? "" : " artifacts-on"}`) as HTMLButtonElement;
        toggle.type = "button";
        toggle.title = this.mode === "hidden" ? "Show comments" : "Hide comments";
        toggle.setAttribute("aria-pressed", String(this.mode !== "hidden"));
        toggle.innerHTML = ICON_COMMENT;
        if (open > 0) toggle.append(el("span", "artifacts-count", String(open)));
        toggle.onclick = () => this.setMode(this.mode === "hidden" ? "open" : "hidden");
        const chevron = el("button", "artifacts-chevron") as HTMLButtonElement;
        chevron.type = "button";
        chevron.title = "Comment view";
        chevron.setAttribute("aria-haspopup", "menu");
        chevron.setAttribute("aria-expanded", String(this.menuOpen));
        chevron.innerHTML = ICON_CHEVRON;
        chevron.onclick = () => {
            this.menuOpen = !this.menuOpen;
            this.render();
        };
        split.append(toggle, chevron);
        tools.append(split);
        if (this.menuOpen) {
            const menu = el("div", "artifacts-menu");
            menu.setAttribute("role", "menu");
            const options: readonly (readonly [CommentMode, string])[] = [
                ["open", "Open comments"],
                ["all", "All comments"],
                ["hidden", "Hide comments"],
            ];
            for (const [mode, label] of options) {
                const item = el("button", `artifacts-menu-item${mode === this.mode ? " artifacts-menu-on" : ""}`, label) as HTMLButtonElement;
                item.type = "button";
                item.setAttribute("role", "menuitemradio");
                item.setAttribute("aria-checked", String(mode === this.mode));
                item.onclick = () => this.setMode(mode);
                menu.append(item);
            }
            tools.append(menu);
        }
        return tools;
    }

    private document(state: ArtifactState): HTMLElement {
        const artifact = el("div", "artifacts-body");
        this.eachBlock(state, (block, index, comments, drafts) => {
            artifact.append(this.block(state, block, index, comments, drafts));
        });
        return artifact;
    }

    // Rows stay in the page so embeds keep playing; only classes and margins are replaced.
    private patchDocument(artifact: HTMLElement, state: ArtifactState): void {
        const rows = Array.from(artifact.children) as HTMLElement[];
        this.eachBlock(state, (block, index, comments, drafts) => {
            const row = rows[index];
            if (row === undefined) return;
            row.className = blockClass(block, comments, drafts);
            row.querySelector(":scope > .pb-margin")?.replaceWith(this.margin(state, block, index, comments, drafts));
        });
    }

    private eachBlock(
        state: ArtifactState,
        visit: (block: Block, index: number, comments: readonly Comment[], drafts: readonly (readonly [string, Draft])[]) => void,
    ): void {
        const last = Math.max(0, state.blocks.length - 1);
        state.blocks.forEach((block, index) => {
            const comments = state.comments.filter((comment) =>
                comment.blockIndex === index && (this.mode === "all" || comment.status === "open")
            );
            const drafts = [...this.drafts.entries()].filter(([, draft]) =>
                placeDraft(draft, state.blocks, last) === index
            );
            visit(block, index, comments, drafts);
        });
    }

    private block(
        state: ArtifactState,
        block: Block,
        index: number,
        comments: readonly Comment[],
        drafts: readonly (readonly [string, Draft])[],
    ): HTMLElement {
        const row = el("div", blockClass(block, comments, drafts));
        row.append(blockBody(block), this.margin(state, block, index, comments, drafts));
        return row;
    }

    private margin(
        state: ArtifactState,
        block: Block,
        index: number,
        comments: readonly Comment[],
        drafts: readonly (readonly [string, Draft])[],
    ): HTMLElement {
        const margin = el("div", "pb-margin");
        if (this.mode === "hidden") return margin;
        for (const comment of comments) margin.append(this.comment(state, comment));
        for (const [key, draft] of drafts) margin.append(this.composer(state, key, draft));
        if (drafts.length === 0) {
            const add = el("button", "pb-add") as HTMLButtonElement;
            add.type = "button";
            add.title = "Comment on this block";
            add.setAttribute("aria-label", "Comment on this block");
            add.innerHTML = ICON_COMMENT;
            add.onclick = () => this.startDraft(block, index);
            margin.append(add);
        }
        return margin;
    }

    private startDraft(block: Block, index: number): void {
        const key = `${index}:${block.text}`;
        if (!this.drafts.has(key)) this.drafts.set(key, { quote: block.text, index, text: "", send: false });
        this.render();
        this.root.querySelector<HTMLTextAreaElement>(`textarea[data-draft="${CSS.escape(key)}"]`)?.focus();
    }

    private comment(state: ArtifactState, comment: Comment): HTMLElement {
        if (comment.status === "closed" && !this.expanded.has(comment.id)) {
            const folded = el("button", "pt pt-folded") as HTMLButtonElement;
            folded.type = "button";
            folded.append(
                el("span", "pt-folded-label", comment.closedBy === "agent" ? "Closed by agent" : "Closed"),
                el("span", "pt-folded-text", firstLine(comment.body)),
            );
            folded.onclick = () => {
                this.expanded.add(comment.id);
                this.render();
            };
            return folded;
        }
        const thread = el("div", `pt-thread${comment.status === "closed" ? " pt-closed" : ""}`);
        const card = el("div", "pt");
        const head = el("div", "pt-head");
        head.append(el("span", "pt-who", state.viewer), el("span", "pt-when", ago(comment.createdAt)));
        if (comment.outdated) head.append(el("span", "pt-badge", "Outdated"));
        if (comment.sentAt !== undefined) head.append(el("span", "pt-badge", "Sent to Vera"));
        if (comment.status === "closed") {
            head.append(el("span", "pt-badge", comment.closedBy === "agent" ? "Closed by agent" : "Closed"));
        }
        card.append(head);
        const quote = quoteLine(comment.quote);
        if (quote.length > 0) card.append(el("div", `pt-quote${comment.outdated ? " pt-quote-gone" : ""}`, quote));
        card.append(el("div", "pt-body", comment.body));
        const unsent = this.unsent.get(comment.id);
        if (unsent !== undefined && comment.sentAt === undefined) card.append(el("div", "pt-note", unsent));
        const actions = el("span", "pt-actions");
        if (comment.status === "closed") {
            actions.append(
                button("Collapse", () => {
                    this.expanded.delete(comment.id);
                    this.render();
                }),
                button("Reopen", () => void this.post("comment", { id: comment.id, action: "reopen" })),
            );
        } else {
            actions.append(button("Resolve", () => void this.post("comment", { id: comment.id, action: "close" })));
        }
        actions.append(button("Delete", () => void this.post("comment", { id: comment.id, action: "delete" })));
        head.append(actions);
        thread.append(avatar(state.viewer), card);
        return thread;
    }

    private composer(state: ArtifactState, key: string, draft: Draft): HTMLElement {
        const thread = el("div", "pt-thread pt-thread-active");
        const form = el("form", "pt pt-compose") as HTMLFormElement;
        const context = el("div", "pt-context");
        const quote = quoteLine(draft.quote);
        context.append(el("span", "pt-context-artifact", state.title));
        if (quote.length > 0) {
            context.append(el("span", "artifacts-sep", "›"), el("span", "pt-context-quote", quote));
            context.title = draft.quote;
        }
        const area = el("textarea", "pt-input") as HTMLTextAreaElement;
        area.dataset.draft = key;
        area.rows = 2;
        area.placeholder = "Add a comment";
        area.value = draft.text;
        const cancel = (): void => {
            this.drafts.delete(key);
            this.render();
        };
        const submit = async (): Promise<void> => {
            const text = draft.text.trim();
            if (text.length === 0) return;
            this.drafts.delete(key);
            const reply = await this.post("comments", { quote: draft.quote, index: draft.index, text, send: draft.send });
            const comment = reply.comment as { readonly id?: unknown } | undefined;
            if (draft.send && typeof comment?.id === "string" && reply.sent !== "queued") {
                this.unsent.set(comment.id, reply.sent === "not_found"
                    ? "Not sent to Vera: the session is not open."
                    : "Not sent to Vera: the host did not answer.");
                this.render();
            }
        };
        const send = el("button", "pt-send") as HTMLButtonElement;
        send.type = "submit";
        send.title = "Comment (⌘↵)";
        send.setAttribute("aria-label", "Comment");
        send.innerHTML = ICON_SEND;
        send.disabled = draft.text.trim().length === 0;
        area.oninput = () => {
            draft.text = area.value;
            send.disabled = draft.text.trim().length === 0;
        };
        area.onkeydown = (event) => {
            if (event.key === "Escape") cancel();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
            }
        };
        form.onsubmit = (event) => {
            event.preventDefault();
            void submit();
        };
        const sendTo = el("label", "pt-sendto");
        const box = el("input", "") as HTMLInputElement;
        box.type = "checkbox";
        box.checked = draft.send;
        box.onchange = () => {
            draft.send = box.checked;
        };
        sendTo.append(box, document.createTextNode("Send to Vera"));
        sendTo.title = "Also send this comment to the session. Its inbox rules decide whether it starts a turn.";
        const foot = el("div", "pt-foot");
        foot.append(sendTo, el("span", "pt-hint", "Esc to cancel"), send);
        form.append(context, area, foot);
        thread.append(avatar(state.viewer), form);
        return thread;
    }
}

function artifactHref(page: string, sessionId: string, name: string): string {
    return `${page}?session=${encodeURIComponent(sessionId)}&artifact=${encodeURIComponent(name)}`;
}

function placeDraft(draft: Draft, blocks: readonly Block[], last: number): number {
    let best: number | undefined;
    blocks.forEach((block, index) => {
        if (block.text !== draft.quote) return;
        if (best === undefined || Math.abs(index - draft.index) < Math.abs(best - draft.index)) best = index;
    });
    return best ?? Math.min(draft.index, last);
}

function readMode(): CommentMode {
    try {
        const stored = localStorage.getItem(MODE_KEY);
        return stored === "all" || stored === "hidden" ? stored : "open";
    } catch {
        return "open";
    }
}

function writeMode(mode: CommentMode): void {
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch {
        // Private windows can refuse storage; the mode just resets on reload.
    }
}

interface FocusSnapshot {
    readonly key: string;
    readonly start: number;
    readonly end: number;
}

function captureFocus(): FocusSnapshot | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement) || active.dataset.draft === undefined) return undefined;
    return { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd };
}

function restoreFocus(root: HTMLElement, focus: FocusSnapshot | undefined): void {
    if (focus === undefined) return;
    const area = root.querySelector<HTMLTextAreaElement>(`textarea[data-draft="${CSS.escape(focus.key)}"]`);
    if (area === null) return;
    area.focus();
    area.setSelectionRange(focus.start, focus.end);
}

function avatar(name: string): HTMLElement {
    const node = el("span", "artifacts-avatar", (name.trim()[0] ?? "?").toUpperCase());
    node.title = name;
    return node;
}

function blockClass(
    block: Block,
    comments: readonly Comment[],
    drafts: readonly (readonly [string, Draft])[],
): string {
    const classes = ["pb", `pb-${block.kind}`];
    if (comments.some((comment) => comment.status === "open")) classes.push("pb-has-open");
    if (drafts.length > 0) classes.push("pb-active");
    return classes.join(" ");
}

function blockBody(block: Block): HTMLElement {
    const body = el("div", "pb-body");
    const source = embedSource(block);
    if (source === undefined) {
        body.innerHTML = block.html;
        return body;
    }
    const frame = document.createElement("iframe");
    frame.className = "pb-embed";
    // Scripts run on an opaque origin: the embed cannot call this page's API or read its storage.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = "Embedded content";
    frame.srcdoc = `${source}\n${EMBED_SHIM}`;
    body.append(frame);
    return body;
}

// A fenced block whose info string is `html embed` runs as a sandboxed page.
export function embedSource(block: Block): string | undefined {
    if (block.kind !== "code") return undefined;
    const lines = block.text.split("\n");
    const open = /^(`{3,}|~{3,})[ \t]*html[ \t]+embed[ \t]*$/.exec(lines[0] ?? "");
    if (open === null) return undefined;
    const fence = open[1] ?? "";
    const closed = lines.length > 1 && (lines[lines.length - 1] ?? "").trim().startsWith(fence);
    return lines.slice(1, closed ? -1 : undefined).join("\n");
}

function blocksKey(blocks: readonly Block[]): string {
    return JSON.stringify(blocks.map((block) => block.text));
}

function el(tag: string, className: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className.length > 0) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
    const node = el("button", "pt-action", label) as HTMLButtonElement;
    node.type = "button";
    node.onclick = onClick;
    return node;
}

function firstLine(text: string): string {
    const line = text.trim().split("\n")[0] ?? "";
    return line.length > 120 ? `${line.slice(0, 120)}...` : line;
}

export function quoteLine(markdown: string): string {
    // An embed has no text worth quoting, and its comments already sit beside it.
    if (embedSource({ kind: "code", text: markdown.trim(), html: "" }) !== undefined) return "";
    const lines = markdown.trim().split("\n");
    const code = /^(`{3,}|~{3,})/.test(lines[0] ?? "") ? lines.slice(1).join("\n") : markdown;
    return firstLine(code).replace(/^(#{1,6}|[-*+]|\d+[.)])\s+/, "");
}

function ago(iso: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 10) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    return new Date(iso).toLocaleDateString();
}

function installStyle(): void {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = PAGE_CSS;
    document.head.append(style);
}

const PAGE_CSS = `
.artifacts { max-width: 760px; margin: 0 auto; padding: 4px 0 64px; }
.artifacts-artifact { max-width: 1100px; }
.artifacts-empty { color: var(--faint); font-size: 13px; margin: 40px 0; text-align: center; }
.artifacts-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 16px; margin-bottom: 20px; padding: 8px 0 12px; border-bottom: 1px solid var(--line); background: var(--bg); }
.artifacts-crumbs { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; }
.artifacts-back { color: var(--muted); text-decoration: none; }
.artifacts-back:hover { color: var(--fg); }
.artifacts-sep { color: var(--faint); }
.artifacts-name { color: var(--fg); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artifacts-meta { margin-left: auto; display: flex; align-items: center; gap: 10px; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.artifacts-live { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.artifacts-live::before { content: ""; width: 6px; height: 6px; background: var(--est); }
.artifacts-live-off::before { background: var(--faint); }
.artifacts-tools { position: relative; display: flex; align-items: center; gap: 8px; }
.artifacts-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; background: var(--fill-2); color: var(--fg); font-size: 12px; font-weight: 600; box-shadow: 0 0 0 1px var(--line-2); }
.artifacts-split { display: inline-flex; border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--card); }
.artifacts-split button { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; color: var(--muted); }
.artifacts-split button:hover, .artifacts-split button:focus-visible { color: var(--fg); background: var(--fill); outline: none; }
.artifacts-toggle.artifacts-on { color: var(--est); background: color-mix(in srgb, var(--est) 14%, transparent); }
.artifacts-toggle.artifacts-on:hover { color: var(--est); background: color-mix(in srgb, var(--est) 20%, transparent); }
.artifacts-chevron { border-left: 1px solid var(--line-2) !important; padding: 0 6px !important; }
.artifacts-count { font-size: 11px; font-variant-numeric: tabular-nums; }
.artifacts-menu { position: absolute; right: 0; top: 32px; min-width: 170px; padding: 4px; background: var(--card); border: 1px solid var(--line-2); border-radius: var(--radius); box-shadow: 0 8px 24px rgb(0 0 0 / 0.35); display: flex; flex-direction: column; }
.artifacts-menu-item { text-align: left; padding: 6px 10px; color: var(--muted); font-size: 13px; }
.artifacts-menu-item:hover, .artifacts-menu-item:focus-visible { color: var(--fg); background: var(--fill); outline: none; }
.artifacts-menu-on { color: var(--fg); }
.artifacts-menu-on::after { content: "✓"; float: right; color: var(--est); }
.artifacts-list { border: 1px solid var(--line); background: var(--card); }
.artifacts-row { display: flex; justify-content: space-between; gap: 16px; padding: 12px 14px; color: var(--fg); text-decoration: none; border-top: 1px solid var(--line); }
.artifacts-row:first-child { border-top: 0; }
.artifacts-row:hover { background: var(--fill); }
.artifacts-row-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.artifacts-row-meta { color: var(--faint); font-size: 12px; white-space: nowrap; }
.artifacts-body { font-size: 14px; line-height: 1.6; }
.pb { display: grid; grid-template-columns: minmax(0, 720px) 320px; column-gap: 36px; }
.artifacts-no-margin .pb { grid-template-columns: minmax(0, 720px); justify-content: center; }
.artifacts-no-margin .pb-margin { display: none; }
.pb-body { align-self: start; min-width: 0; padding: 2px 0 2px 14px; border-left: 2px solid transparent; }
.pb-body img, .pb-body video { display: block; max-width: 100%; height: auto; margin: 8px 0; border-radius: var(--radius); }
.pb-body audio { display: block; width: 100%; max-width: 480px; margin: 8px 0; }
.pb-embed { display: block; width: 100%; height: 32px; border: 1px solid var(--line); border-radius: var(--radius); background: transparent; }
.pb:hover .pb-body { border-left-color: var(--line-2); }
.pb-has-open .pb-body, .pb-has-open:hover .pb-body { border-left-color: var(--est); }
.pb-active .pb-body, .pb-active:hover .pb-body { border-left-color: var(--est); background: color-mix(in srgb, var(--est) 6%, transparent); }
.pb-margin { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 10px; }
.pb-add { align-self: flex-start; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; color: var(--muted); border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--card); opacity: 0; }
.pb-has-open .pb-add { display: none; }
.pb:hover .pb-add, .pb-add:focus-visible { opacity: 1; }
.pb-add:hover, .pb-add:focus-visible { color: var(--est); border-color: var(--est); outline: none; }
.pb-body > :first-child { margin-top: 0; }
.pb-body > :last-child { margin-bottom: 0; }
.pb-body h1 { font-size: 24px; font-weight: 600; line-height: 1.25; margin: 18px 0 10px; }
.pb-body h2 { font-size: 18px; font-weight: 600; margin: 22px 0 6px; }
.pb-body h3, .pb-body h4 { font-size: 15px; font-weight: 600; margin: 18px 0 4px; }
.pb-body p { margin: 8px 0; }
.pb-body ul, .pb-body ol { margin: 0; padding-left: 22px; }
.pb-list_item .pb-body li { margin: 2px 0; }
.pb-body code { background: var(--fill); padding: 1px 5px; font-size: 12.5px; }
.pb-body pre { background: var(--fill); border: 1px solid var(--line); padding: 10px 12px; overflow-x: auto; margin: 10px 0; }
.pb-body pre code { background: none; padding: 0; }
.pb-body blockquote { margin: 8px 0; padding-left: 12px; border-left: 2px solid var(--line-2); color: var(--muted); }
.pb-body a { color: var(--est); }
.pb-body table { border-collapse: collapse; margin: 10px 0; }
.pb-body th, .pb-body td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
.pb-body hr { border: 0; border-top: 1px solid var(--line); margin: 18px 0; }
.pt-thread { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 1.45; }
.pt-thread .artifacts-avatar { margin-top: 6px; width: 24px; height: 24px; font-size: 11px; }
.pt-thread-active .artifacts-avatar { box-shadow: 0 0 0 2px var(--est); }
.pt-closed { opacity: 0.7; }
.pt { position: relative; flex: 1; min-width: 0; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 10px; }
.pt-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.pt-who { font-weight: 600; }
.pt-when { color: var(--faint); font-size: 12px; white-space: nowrap; }
.pt-badge { font-size: 11px; color: var(--muted); border: 1px solid var(--line-2); padding: 0 6px; white-space: nowrap; }
.pt-quote { margin: 4px 0; color: var(--faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-quote-gone { text-decoration: line-through; }
.pt-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.pt-actions { position: absolute; top: 4px; right: 4px; display: flex; gap: 2px; padding-left: 8px; background: var(--card); opacity: 0; }
.pt:hover .pt-actions, .pt:focus-within .pt-actions { opacity: 1; }
.pt-action { color: var(--faint); font-size: 12px; padding: 2px 6px; }
.pt-action:hover, .pt-action:focus-visible { color: var(--fg); background: var(--fill); outline: none; }
.pt-folded { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; color: var(--faint); padding: 5px 10px; margin-left: 32px; width: calc(100% - 32px); }
.pt-folded:hover { color: var(--muted); background: var(--fill); }
.pt-folded-label { color: var(--muted); white-space: nowrap; }
.pt-folded-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-compose { display: flex; flex-direction: column; gap: 6px; border-color: var(--line-2); box-shadow: 0 8px 24px rgb(0 0 0 / 0.25); }
.pt-compose:focus-within { border-color: var(--est); }
.pt-context { display: flex; gap: 6px; min-width: 0; color: var(--faint); font-size: 12px; white-space: nowrap; }
.pt-context-artifact { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; }
.pt-context-quote { overflow: hidden; text-overflow: ellipsis; }
.pt-input { width: 100%; resize: none; min-height: 40px; background: transparent; color: var(--fg); border: 0; padding: 0; font: inherit; field-sizing: content; max-height: 240px; }
.pt-input:focus { outline: none; }
.pt-foot { display: flex; align-items: center; gap: 8px; }
.pt-sendto { margin-right: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; cursor: pointer; }
.pt-sendto input { margin: 0; accent-color: var(--est); }
.pt-hint { color: var(--faint); font-size: 11px; }
.pt-note { margin-top: 4px; color: var(--bad); font-size: 12px; }
.pt-send { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: var(--est); color: #fff; border-radius: var(--radius); }
.pt-send:disabled { background: var(--fill-2); color: var(--faint); cursor: default; }
.pt-send:not(:disabled):hover, .pt-send:focus-visible { filter: brightness(1.1); outline: none; }
@media (max-width: 1100px) {
    .pb, .artifacts-no-margin .pb { grid-template-columns: minmax(0, 1fr); }
    .pb-margin { padding-left: 16px; }
    .pb-margin:empty, .pb-margin:has(> .pb-add:only-child) { padding: 0; }
    .pb { position: relative; }
    .pb-body { margin-right: 34px; }
    .artifacts-no-margin .pb-body { margin-right: 0; }
    .pb-add { position: absolute; top: 0; right: 0; opacity: 1; }
    .artifacts-meta > :last-child { display: none; }
}
`;
