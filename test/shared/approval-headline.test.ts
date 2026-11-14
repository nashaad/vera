import { describe, expect, test } from "bun:test";

import { approvalHeadline, type ApprovalHeadlineInput } from "../../clients/shared/approval-headline.ts";

const CHAT = "/home/ana/.vera/runtime/sessions/abc.jsonl.files";

function ask(overrides: Partial<ApprovalHeadlineInput>): ApprovalHeadlineInput {
    return { tool: "bash", input: {}, grants: [], shell: true, workspace: CHAT, chat: true, ...overrides };
}

describe("approvalHeadline", () => {
    test("a write outside a chat's folder names the file and where it lands", () => {
        const headline = approvalHeadline(ask({
            input: { command: "cd .. && printf 'hello' > hello.txt" },
            grants: [{ verb: "write", path: "/home/ana/.vera/runtime/sessions/hello.txt" }],
        }));
        expect(headline).toEqual({
            question: "Write hello.txt outside this chat's folder?",
            folder: "/home/ana/.vera/runtime/sessions",
            commandOpen: false,
        });
    });

    test("a project session names its folder", () => {
        const headline = approvalHeadline(ask({
            workspace: "/home/ana/harbor",
            chat: false,
            grants: [{ verb: "delete", path: "/home/ana/notes/old.md" }],
        }));
        expect(headline?.question).toBe("Delete old.md outside the harbor folder?");
    });

    test("a path inside the working folder says no more than the action", () => {
        const headline = approvalHeadline(ask({ grants: [{ verb: "delete", path: `${CHAT}/draft.md` }] }));
        expect(headline?.question).toBe("Delete draft.md?");
        expect(headline?.folder).toBe(CHAT);
    });

    test("several files share one question and their common folder", () => {
        const headline = approvalHeadline(ask({
            grants: [
                { verb: "write", path: "/tmp/out/a.txt" },
                { verb: "delete", path: "/tmp/out/b/c.txt" },
            ],
        }));
        expect(headline).toEqual({ question: "Change 2 files outside this chat's folder?", folder: "/tmp/out", commandOpen: false });
    });

    test("an unknown workspace drops the outside phrase", () => {
        const headline = approvalHeadline(ask({ workspace: undefined, grants: [{ verb: "read", path: "/etc/hosts" }] }));
        expect(headline?.question).toBe("Read hosts?");
    });

    test("an operation reads as a question, and a fetch names its host", () => {
        expect(approvalHeadline(ask({ grants: [{ operation: "git.push" }] }))?.question).toBe("Push to a git remote?");
        expect(approvalHeadline(ask({
            tool: "web_fetch",
            shell: false,
            input: { url: "https://example.com/a" },
            grants: [{ operation: "web.fetch" }],
        }))?.question).toBe("Fetch example.com?");
        expect(approvalHeadline(ask({ grants: [{ operation: "custom.thing" }] }))?.question).toBe("Allow custom.thing?");
    });

    test("a command Vera cannot describe shows the command", () => {
        expect(approvalHeadline(ask({ grants: [{ tool: "bash", executable: "curl" }] })))
            .toEqual({ question: "Run curl?", commandOpen: true });
        expect(approvalHeadline(ask({ grants: [] }))).toEqual({ question: "Run this command?", commandOpen: true });
        expect(approvalHeadline(ask({
            grants: [{ verb: "write", path: "/tmp/a" }, { tool: "bash", executable: "curl" }],
        }))).toEqual({ question: "Run this command?", commandOpen: true });
    });

    test("a tool other than a shell with nothing to say leaves the title to the client", () => {
        expect(approvalHeadline(ask({ tool: "custom", shell: false, grants: [] }))).toBeUndefined();
    });
});
