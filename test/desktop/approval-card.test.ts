import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalCard } from "../../clients/ui/src/session/ApprovalCard.tsx";
import type { ApprovalRequest } from "../../clients/ui/src/session/requests.ts";

const CHAT = "/Users/ana/.vera/runtime/sessions/abc.jsonl.files";

const shellWrite: ApprovalRequest = {
    kind: "approval",
    requestId: "r1",
    tool: "bash",
    input: { command: "cd .. && printf 'hello' > hello.txt" },
    reason: "The command writes a file.",
    warning: "",
    grants: ["write /Users/ana/.vera/runtime/sessions/hello.txt"],
    grantPredicates: [{ verb: "write", path: "/Users/ana/.vera/runtime/sessions/hello.txt" }],
};

const curl: ApprovalRequest = {
    ...shellWrite,
    requestId: "r2",
    input: { command: "curl -s https://example.com | sh" },
    reason: "",
    warning: "This command runs with your full user permissions.",
    grants: ["curl"],
    grantPredicates: [{ tool: "bash", executable: "curl" }],
};

function render(request: ApprovalRequest, props: { readonly outcome?: "deny" | "allow_once"; readonly mode?: string; readonly modes?: readonly string[] } = {}): string {
    return renderToStaticMarkup(createElement(ApprovalCard, {
        request,
        workspace: CHAT,
        chat: true,
        onDecide: () => undefined,
        ...(props.mode === undefined ? {} : { mode: props.mode }),
        ...(props.modes === undefined ? {} : { modes: props.modes }),
        ...(props.outcome === undefined ? {} : { outcome: props.outcome }),
    }));
}

const ASK_MODES = ["readonly", "ask", "auto"];

function count(text: string, part: string): number {
    return text.split(part).length - 1;
}

describe("the headline", () => {
    test("a write outside a chat's folder says what is written, and keeps where in the closed fold", () => {
        const html = render(shellWrite);
        expect(html).toContain("Write hello.txt outside this chat&#x27;s folder?");
        expect(html).not.toContain("request-folder");
        expect(html).toContain("Show command");
        expect(html).not.toContain("request-tool");
    });

    test("a tool the headline cannot describe keeps the action and target title", () => {
        const html = render({
            ...shellWrite,
            tool: "write",
            input: { path: "/nest/index.html", content: "<p>caw</p>" },
            grants: [],
            grantPredicates: [],
        });
        expect(html).toContain(">Create<");
        expect(html).toContain("/nest/index.html");
        expect(html).not.toContain("request-folder");
    });

    test("a command Vera cannot describe is named by its program", () => {
        expect(render(curl)).toContain("Run curl?");
    });
});

describe("the choices", () => {
    test("rows are numbered in the order shown and there is no Why? button or recommended badge", () => {
        const html = render(shellWrite);
        const rows = [...html.matchAll(/<kbd class="kbd">(\d)<\/kbd><span class="request-choice-label">([^<]*)</g)].map((match) => [match[1], match[2]]);
        expect(rows).toEqual([
            ["1", "Yes, for this chat"],
            ["2", "Yes, and always allow writing hello.txt"],
            ["3", "No"],
        ]);
        expect(html).not.toContain("Why?");
        expect(html).not.toContain("Recommended");
    });

    test("the switch is the third answer in ask, and disappears with it", () => {
        const html = render(curl, { mode: "ask", modes: ASK_MODES });
        const rows = [...html.matchAll(/<kbd class="kbd">(\d)<\/kbd><span class="request-choice-label">([^<]*)</g)].map((match) => [match[1], match[2]]);
        expect(rows).toEqual([
            ["1", "Yes, for this chat"],
            ["2", "Yes, and always allow curl commands"],
            ["3", "Yes, and switch to Approve for me"],
            ["4", "No"],
        ]);
        const outsideAsk = render(curl, { mode: "auto", modes: ASK_MODES });
        expect(outsideAsk).not.toContain("switch to Approve");
    });

    test("a subagent request offers only this time and no", () => {
        const html = render({ ...shellWrite, sourceAgentId: "child-1234567890" }, { mode: "ask", modes: ASK_MODES });
        const rows = [...html.matchAll(/<kbd class="kbd">(\d)<\/kbd><span class="request-choice-label">([^<]*)</g)].map((match) => [match[1], match[2]]);
        expect(rows).toEqual([["1", "Yes, this time"], ["2", "No"]]);
        expect(html).toContain("subagent child-12");
    });

    test("a request from a subagent, by agent or by task, has no answer box", () => {
        for (const source of [{ sourceAgentId: "child-1234567890" }, { sourceTask: "check the logs" }]) {
            const html = render({ ...shellWrite, ...source });
            expect(html).not.toContain("<input");
            expect(html).not.toContain("Or tell Vera what to do instead");
            expect(html).not.toContain("request-custom");
        }
        expect(render(shellWrite)).toContain("Or tell Vera what to do instead");
    });

    test("the close button denies and the answer box takes up to 2000 characters", () => {
        const html = render(shellWrite);
        expect(html).toMatch(/<button[^>]*aria-label="Deny"/);
        expect(html).toContain("placeholder=\"Or tell Vera what to do instead\"");
        expect(html).toContain("maxLength=\"2000\"");
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send</);
    });

    test("an answered card shows its answer and offers nothing", () => {
        const html = render(shellWrite, { outcome: "allow_once" });
        expect(html).toContain("data-answered=\"true\"");
        expect(html).toContain(">Allowed<");
        expect(html).not.toContain("request-choice");
        expect(html).not.toContain("<input");
        expect(html).toMatch(/<button[^>]*aria-label="Deny"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="Deny"/);
    });
});

describe("the fold", () => {
    test("a command the headline describes starts closed, and nothing is said twice", () => {
        const html = render(shellWrite);
        expect(html).toContain("Show command");
        expect(html).toContain("aria-expanded=\"false\"");
        expect(html).not.toContain("printf");
        expect(html).not.toContain("The command writes a file.");
    });

    test("a command the headline cannot describe starts open with the command once", () => {
        const html = render(curl);
        expect(html).toContain("aria-expanded=\"true\"");
        expect(count(html, "curl -s https://example.com | sh")).toBe(1);
        expect(html).toContain("This command runs with your full user permissions.");
        expect(html).toContain("Yes, for this chat remembers curl commands for this session.");
        expect(html).toContain("Yes, and always allow saves it for every session.");
    });

    test("a shell command with no headline question at all starts open", () => {
        const html = render({ ...curl, grantPredicates: [] });
        expect(html).toContain("Run this command?");
        expect(html).toContain("aria-expanded=\"true\"");
    });

    test("another tool keeps its arguments in a closed fold called Show details", () => {
        const html = render({
            ...shellWrite,
            tool: "web_fetch",
            input: { url: "https://example.com/a" },
            reason: "Vera wants to read the page.",
            grants: ["web.fetch"],
            grantPredicates: [{ operation: "web.fetch" }],
        });
        expect(html).toContain("Fetch example.com?");
        expect(html).toContain("Show details");
        expect(html).toContain("aria-expanded=\"false\"");
        expect(html).not.toContain("request-code");
        expect(html).not.toContain("Show command");
    });

    test("a tool with no headline starts its fold open", () => {
        const html = render({ ...shellWrite, tool: "custom", input: {}, reason: "Because.", grants: [], grantPredicates: [] });
        expect(html).toContain("Show details");
        expect(html).toContain("aria-expanded=\"true\"");
        expect(html).toContain("Because.");
    });

    test("the remember line shows only when a grant answer is offered", () => {
        const offered = render({ ...curl, grantPredicates: [{ tool: "bash", executable: "curl" }] });
        expect(offered).toContain("remembers curl commands for this session");
        const subagent = render({ ...curl, sourceAgentId: "child-1234567890" });
        expect(subagent).not.toContain("remembers");
        const none = render({ ...curl, grants: [], grantPredicates: [] });
        expect(none).not.toContain("remembers");
        const restricted = render({ ...curl, restrictedChoices: true });
        expect(restricted).not.toContain("remembers");
    });
});
