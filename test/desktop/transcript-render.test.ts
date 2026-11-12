import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalCard, DeniedLine } from "../../clients/ui/src/session/ApprovalCard.tsx";
import { LiveStatus, TaskCard } from "../../clients/ui/src/session/LiveStatus.tsx";
import { Markdown } from "../../clients/ui/src/session/Markdown.tsx";
import type { ToolCall } from "../../clients/ui/src/session/model.ts";
import type { ApprovalRequest } from "../../clients/ui/src/session/requests.ts";
import { RunLine } from "../../clients/ui/src/session/ToolRuns.tsx";

const status = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(LiveStatus, { calls: [], streaming: false, tokens: 0, waiting: false, ...props }));

test("@core streaming text fades in word by word, and settled text carries no word spans", () => {
    const live = renderToStaticMarkup(createElement(Markdown, { text: "The crow **lands** softly", fade: true }));
    expect(live.match(/class="word-in"/g)?.length).toBe(3);
    expect(live).toContain("<strong>lands</strong>");
    const settled = renderToStaticMarkup(createElement(Markdown, { text: "The crow **lands** softly" }));
    expect(settled).not.toContain("word-in");
});

test("only the last block of a streaming reply fades", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "First nest.\n\nSecond nest", fade: true }));
    expect(html.match(/class="word-in"/g)?.length).toBe(2);
    expect(html.indexOf("First nest.")).toBeLessThan(html.indexOf("word-in"));
});

test("@core the status line keeps one place and changes its words", () => {
    expect(status({ waiting: true })).toContain("Waiting on you");
    const reading: ToolCall = { tool: "read", title: "read app.js", args: { path: "/nest/app.js" }, state: "running" };
    const tool = status({ calls: [reading], since: Date.now() - 4_000 });
    expect(tool).toContain("Reading");
    expect(tool).toContain("app.js");
    expect(tool).toContain("4s");
    expect(tool).toContain("aria-expanded=\"false\"");
    const retrying = status({ retry: { model: "crow-0", nextAttempt: 2, maxAttempts: 4, failureKind: "overloaded" } });
    expect(retrying).toContain("Retrying on crow-0");
    const writing = status({ streaming: true, tokens: 236, since: Date.now() - 12_000 });
    expect(writing).toContain("12s · 236 tokens");
});

test("thinking shows the turn clock after two seconds and no reasoning text", () => {
    expect(status({ since: Date.now() - 500 })).not.toContain("s ·");
    const late = status({ since: Date.now() - 5_000 });
    expect(late).toContain("5s ·");
    expect(late).toContain("Thinking");
    expect(late).toContain("live-dots");
});

test("the task card lists the plan with done items marked", () => {
    const html = renderToStaticMarkup(createElement(TaskCard, {
        checklist: { path: "plan.md", items: [{ text: "Find the nest", done: true, justDone: false }, { text: "Land", done: false, justDone: false }] },
    }));
    expect(html).toContain("Find the nest");
    expect(html).toMatch(/data-done="true"[^>]*>.*Find the nest/);
    expect(html).toMatch(/data-done="false"[^>]*>.*Land/);
});

test("a finished run is one closed line with its summary", () => {
    const calls: ToolCall[] = [
        { tool: "bash", title: "bash ls", args: { command: "ls" }, state: "done", output: "a" },
        { tool: "read", title: "read a", args: { path: "/w/a" }, state: "failed", output: "missing" },
    ];
    const html = renderToStaticMarkup(createElement(RunLine, { calls }));
    expect(html).toContain("Ran a command, read a file");
    expect(html).toContain("1 failed");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("call-line");
});

const approval: ApprovalRequest = {
    kind: "approval",
    requestId: "r1",
    tool: "write",
    input: { path: "/nest/index.html", content: "<p>caw</p>" },
    reason: "",
    warning: "",
    grants: [],
};

test("@core an approval's title is the action and its target", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { request: approval, onDecide: () => undefined }));
    expect(html).toContain(">Create<");
    expect(html).toContain("/nest/index.html");
    expect(html).toContain("Allow once");
});

test("an answered approval shows its answer in place of the choices", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { request: approval, outcome: "deny", onDecide: () => undefined }));
    expect(html).toContain("Denied");
    expect(html).not.toContain("Allow once");
    expect(html).toContain("data-answered=\"true\"");
});

test("a denied approval leaves one muted line that is not a card", () => {
    const html = renderToStaticMarkup(createElement(DeniedLine, { request: approval }));
    expect(html).toContain("Denied: Create /nest/index.html");
    expect(html).not.toContain("request-card");
});
