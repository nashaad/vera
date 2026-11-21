import { describe, expect, test } from "bun:test";

import {
    alwaysAllowWords,
    approvalAnswers,
    type ApprovalAnswerGrant,
    type ApprovalAnswersInput,
} from "../../clients/shared/approval-answers.ts";

function ask(overrides: Partial<ApprovalAnswersInput> = {}): ApprovalAnswersInput {
    return {
        grants: [{ tool: "bash", executable: "curl" }],
        subagent: false,
        restricted: false,
        mode: "ask",
        modes: ["readonly", "ask", "auto"],
        ...overrides,
    };
}

function labels(overrides: Partial<ApprovalAnswersInput> = {}): readonly string[] {
    return approvalAnswers(ask(overrides)).map((answer) => answer.label);
}

describe("the answers", () => {
    test("ask, with a grant and a subagent-free call, offers four answers in order", () => {
        expect(approvalAnswers(ask())).toEqual([
            { decision: "allow_similar", label: "Yes, for this chat" },
            { decision: "allow_always", label: "Yes, and always allow curl commands" },
            { decision: "allow_once", label: "Yes, and switch to Approve for me", switchToAuto: true },
            { decision: "deny", label: "No" },
        ]);
    });

    test("a subagent's call offers this time and no, and no typed answer", () => {
        expect(labels({ subagent: true })).toEqual(["Yes, this time", "No"]);
    });

    test("an ask from permission_rules offers this time, no, and never the switch", () => {
        expect(labels({ restricted: true })).toEqual(["Yes, this time", "No"]);
        const answers = approvalAnswers(ask({ restricted: true }));
        expect(answers.some((answer) => answer.switchToAuto === true)).toBe(false);
    });

    test("a call with no grant to propose offers this time, the switch, and no", () => {
        expect(labels({ grants: [] })).toEqual([
            "Yes, this time",
            "Yes, and switch to Approve for me",
            "No",
        ]);
    });

    test("the switch is left out outside ask, and when auto is not offered", () => {
        for (const input of [
            ask({ mode: "auto" }),
            ask({ mode: "readonly" }),
            ask({ mode: "" }),
            ask({ modes: ["readonly", "ask"] }),
            ask({ modes: [] }),
        ]) {
            expect(labels(input)).not.toContain("Yes, and switch to Approve for me");
        }
    });

    test("the switch sends the allow first and then the mode change", () => {
        const answer = approvalAnswers(ask()).find((candidate) => candidate.switchToAuto === true);
        expect(answer).toEqual({
            decision: "allow_once",
            label: "Yes, and switch to Approve for me",
            switchToAuto: true,
        });
    });

    test("an answer that is left out leaves no gap", () => {
        expect(labels()).toHaveLength(4);
        expect(labels({ restricted: true })).toHaveLength(2);
        expect(labels({ mode: "auto" })).toEqual([
            "Yes, for this chat",
            "Yes, and always allow curl commands",
            "No",
        ]);
    });
});

describe("the words after always allow", () => {
    test("a path grant names the verb and the file", () => {
        expect(alwaysAllowWords([{ verb: "read", path: "/hold/plunder.md" }]))
            .toBe("reading plunder.md");
        expect(alwaysAllowWords([{ verb: "write", path: "/hold/plunder.md" }]))
            .toBe("writing plunder.md");
        expect(alwaysAllowWords([{ verb: "delete", path: "/hold/plunder.md" }]))
            .toBe("deleting plunder.md");
    });

    test("paths that differ say changing and how many files", () => {
        expect(alwaysAllowWords([
            { verb: "write", path: "/hold/one.md" },
            { verb: "write", path: "/hold/two.md" },
        ])).toBe("writing 2 files");
        expect(alwaysAllowWords([
            { verb: "read", path: "/hold/one.md" },
            { verb: "write", path: "/hold/two.md" },
        ])).toBe("changing 2 files");
        expect(alwaysAllowWords([{ path: "/hold/one.md" }])).toBe("changing one.md");
        expect(alwaysAllowWords([
            { verb: "write", path: "/hold/one.md" },
            { verb: "write", path: "/hold/one.md" },
        ])).toBe("writing one.md");
    });

    test("the operation table reads word for word", () => {
        const words: Readonly<Record<string, string>> = {
            "agent.close": "closing helper agents",
            "agent.inbox": "reading helper agents' messages",
            "agent.message": "messaging helper agents",
            "agent.roster": "listing helper agents",
            "agent.spawn": "starting helper agents",
            "desktop.browser.eval": "running scripts in the Browser pane",
            "git.clone": "git clones",
            "git.commit": "git commits",
            "git.fetch": "git fetches",
            "git.ls_remote": "reading git remotes",
            "git.pull": "git pulls",
            "git.push": "git pushes",
            "git.remote_update": "git remote updates",
            "memory.write": "saving to memory",
            "process.kill": "stopping processes",
            "process.read": "reading process output",
            "web.search": "web searches",
        };
        for (const [operation, expected] of Object.entries(words)) {
            expect(alwaysAllowWords([{ operation }]), operation).toBe(expected);
        }
    });

    test("a web fetch names its host, and web fetches without one", () => {
        expect(alwaysAllowWords([{ operation: "web.fetch", host: "example.com" }]))
            .toBe("example.com");
        expect(alwaysAllowWords([{ operation: "web.fetch" }])).toBe("web fetches");
    });

    test("a web download names its host, and web downloads without one", () => {
        expect(alwaysAllowWords([{ operation: "web.download", host: "example.com" }]))
            .toBe("downloads from example.com");
        expect(alwaysAllowWords([{ operation: "web.download" }])).toBe("web downloads");
    });

    test("any other operation reads its own name", () => {
        expect(alwaysAllowWords([{ operation: "function.call" }])).toBe("function.call");
        expect(alwaysAllowWords([{ operation: "crow.shout" }])).toBe("crow.shout");
    });

    test("@core an eval approval always allows running scripts in the Browser pane", () => {
        const answers = approvalAnswers(ask({
            grants: [{ tool: "builtin_browser_eval", operation: "desktop.browser.eval" }],
        }));
        expect(answers[1]?.label)
            .toBe("Yes, and always allow running scripts in the Browser pane");
    });

    test("a shell executable alone reads as its commands", () => {
        expect(alwaysAllowWords([{ tool: "bash", executable: "git" }]))
            .toBe("git commands");
        expect(alwaysAllowWords([{ tool: "bash", verb: "unknown", executable: "curl" }]))
            .toBe("curl commands");
    });

    test("anything else reads actions like this", () => {
        expect(alwaysAllowWords([])).toBe("actions like this");
        expect(alwaysAllowWords([{ tool: "shanty_shout", verb: "unknown" }]))
            .toBe("actions like this");
        expect(alwaysAllowWords([{ tool: "bash", verb: "write" }]))
            .toBe("actions like this");
        expect(alwaysAllowWords([
            { operation: "git.push" },
            { tool: "bash", verb: "unknown" },
        ])).toBe("actions like this");
    });

    test("the label carries the words", () => {
        expect(approvalAnswers(ask({
            grants: [{ operation: "web.fetch", host: "example.com" }],
        }))[1]?.label).toBe("Yes, and always allow example.com");
        expect(approvalAnswers(ask({
            grants: [{ operation: "web.download", host: "example.com" }],
        }))[1]?.label).toBe("Yes, and always allow downloads from example.com");
    });
});
