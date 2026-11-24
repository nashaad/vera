import { expect, test } from "bun:test";

import {
    isSearchResultFindReady,
    isSearchResultFindRequest,
    PendingSearchResultFind,
    searchResultFindReady,
    searchResultFindRequest,
    selectSearchResultMatch,
    type SearchResultFindRequest,
} from "../../clients/ui/src/find/search-result.ts";
import type { SessionSearchHit } from "../../clients/ui/src/protocol/bridge.ts";

const hit: SessionSearchHit = { kind: "user_message", snippet: "pirate crow", entryId: "entry-2" };

class ElementFixture {
    readonly nodeType = 1;
    readonly parentElement: ElementFixture | null;
    parentNode: ElementFixture | { readonly nodeType: number; readonly host: ElementFixture } | null;
    readonly assignedSlot = null;
    private readonly attributes: Readonly<Record<string, string>>;
    private readonly classes: readonly string[];

    constructor(parent: ElementFixture | null, classes: readonly string[] = [], attributes: Readonly<Record<string, string>> = {}) {
        this.parentElement = parent;
        this.parentNode = parent;
        this.classes = classes;
        this.attributes = attributes;
    }

    getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
    }

    matches(selector: string): boolean {
        if (selector === ".session-page") return this.classes.includes("session-page");
        if (selector === ".transcript-scroll[data-session]") return this.classes.includes("transcript-scroll") && this.getAttribute("data-session") !== null;
        return false;
    }
}

function range(parent: ElementFixture): Range {
    return { startContainer: { nodeType: 3, parentElement: parent } } as unknown as Range;
}

function request(entryId: string | null = "entry-2"): SearchResultFindRequest {
    return { type: "search-result", agentId: "session-1", query: "crow", entryId };
}

function fixture() {
    const app = new ElementFixture(null);
    const sidebar = new ElementFixture(app);
    const main = new ElementFixture(app, ["session-page"], { "data-pane": "main" });
    const transcript = new ElementFixture(main, ["transcript-scroll"], { "data-session": "session-1" });
    const first = new ElementFixture(transcript, [], { "data-find-entry": "entry-1#0" });
    const collision = new ElementFixture(transcript, [], { "data-find-entry": "entry-2#1#0" });
    const target = new ElementFixture(transcript, [], { "data-find-entry": "entry-2#3" });
    const nested = new ElementFixture(target);
    const right = new ElementFixture(app, ["session-page"], { "data-pane": "chat:0" });
    const rightTranscript = new ElementFixture(right, ["transcript-scroll"], { "data-session": "session-1" });
    const rightTarget = new ElementFixture(rightTranscript, [], { "data-find-entry": "entry-2#0" });
    return { sidebar, first, collision, nested, rightTarget };
}

test("@core a content result waits for its own loaded main session once", () => {
    const content = searchResultFindRequest("session-1", "pirate crow", hit);
    expect(content).toEqual({ type: "search-result", agentId: "session-1", query: "pirate crow", entryId: "entry-2" });
    expect(isSearchResultFindRequest(content)).toBe(true);
    expect(searchResultFindRequest("session-1", "pirate crow", undefined)).toBeUndefined();
    expect(searchResultFindRequest("session-1", "", hit)).toBeUndefined();
    expect(isSearchResultFindRequest({ ...content, entryId: undefined })).toBe(false);

    const pending = new PendingSearchResultFind();
    pending.set(content!);
    pending.routeChanged({ kind: "session", agentId: "session-1", title: "Crow" });
    const preservePosition = () => {};
    expect(searchResultFindReady("session-1", "main", { agentId: "session-1", loaded: false }, preservePosition)).toBeUndefined();
    expect(searchResultFindReady("session-1", "main", { agentId: "other", loaded: true }, preservePosition)).toBeUndefined();
    expect(searchResultFindReady("session-1", "chat:0", { agentId: "session-1", loaded: true }, preservePosition)).toBeUndefined();
    expect(pending.take("other")).toBeUndefined();
    const ready = searchResultFindReady("session-1", "main", { agentId: "session-1", loaded: true }, preservePosition);
    expect(isSearchResultFindReady(ready)).toBe(true);
    expect(ready?.preservePosition).toBe(preservePosition);
    expect(pending.take(ready!.agentId)).toEqual(content);
    expect(pending.take("session-1")).toBeUndefined();
});

test("a result request is dropped when navigating elsewhere", () => {
    const pending = new PendingSearchResultFind();
    pending.set(request());
    pending.routeChanged({ kind: "settings" });
    expect(pending.take("session-1")).toBeUndefined();
    pending.set(request());
    pending.routeChanged({ kind: "session", agentId: "other", title: "Other" });
    expect(pending.take("session-1")).toBeUndefined();
    pending.set(request(null));
    expect(pending.take("session-1")?.entryId).toBeNull();
});

test("@core the clicked entry is current instead of an earlier window or session match", () => {
    const { sidebar, first, collision, nested, rightTarget } = fixture();
    const matches = [range(sidebar), range(first), range(collision), range(rightTarget), range(nested)];
    expect(selectSearchResultMatch(matches, request())).toEqual({ index: 4, inSession: true });
    expect(selectSearchResultMatch(matches.slice(0, 4), request())).toEqual({ index: 1, inSession: true });
    expect(selectSearchResultMatch(matches, request(null))).toEqual({ index: 1, inSession: true });
});

test("a match inside an open shadow root retains its transcript entry", () => {
    const app = new ElementFixture(null);
    const page = new ElementFixture(app, ["session-page"], { "data-pane": "main" });
    const transcript = new ElementFixture(page, ["transcript-scroll"], { "data-session": "session-1" });
    const first = new ElementFixture(transcript, [], { "data-find-entry": "entry-1" });
    const target = new ElementFixture(transcript, [], { "data-find-entry": "entry-2#0" });
    const inside = new ElementFixture(null);
    inside.parentNode = { nodeType: 11, host: target };
    expect(selectSearchResultMatch([range(first), range(inside)], request())).toEqual({ index: 1, inSession: true });
    expect(selectSearchResultMatch([range(first), range(inside)], request(null))).toEqual({ index: 0, inSession: true });
});

test("fallback keeps whole-window matches without scrolling outside the session", () => {
    const { sidebar, rightTarget } = fixture();
    expect(selectSearchResultMatch([range(sidebar), range(rightTarget)], request())).toEqual({ index: 0, inSession: false });
    expect(selectSearchResultMatch([], request())).toEqual({ index: -1, inSession: false });
});
