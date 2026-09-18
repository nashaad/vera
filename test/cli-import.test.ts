import { expect, test } from "bun:test";

import { renderImportableSessions, runCli } from "../clients/cli/main.ts";
import type { ImportableSessionListing } from "../src/host/session-import-service.ts";

function capture(): { readonly text: () => string; readonly write: (chunk: string) => boolean } {
    let text = "";
    return {
        text: () => text,
        write: (chunk: string) => {
            text += chunk;
            return true;
        },
    };
}

const listing: ImportableSessionListing = {
    sessions: [
        {
            tool: "claude-code",
            path: "/h/.claude/projects/-w/a.jsonl",
            source_session_id: "cc-1",
            workspace: "/w",
            updated_at: "2026-09-15T12:00:00.000Z",
            title: "Fix the build",
            first_message: "fix it",
            imported_session_id: "vera-1",
        },
        {
            tool: "codex",
            path: "/h/.codex/sessions/2026/09/16/r.jsonl",
            source_session_id: "cx-1",
            workspace: "/w",
            updated_at: "2026-09-16T12:00:00.000Z",
            first_message: "add a\ntest",
        },
    ],
    truncated: true,
};

test("the importable list shows tool, age, title, import mark and path", () => {
    expect(renderImportableSessions(listing, { now: new Date("2026-09-17T12:00:00.000Z") })).toBe([
        "TOOL         CHANGED  TITLE          IMPORTED  PATH",
        "Claude Code  2d ago   Fix the build  yes       /h/.claude/projects/-w/a.jsonl",
        "Codex        1d ago   add a test               /h/.codex/sessions/2026/09/16/r.jsonl",
        "Showing the newest 2.",
        "Import one with: vera import <path>",
        "",
    ].join("\n"));
});

test("an empty list says where else to look", () => {
    expect(renderImportableSessions({ sessions: [], truncated: false }))
        .toBe("No Claude Code or Codex sessions in this folder. Use --all to see every one.\n");
    expect(renderImportableSessions({ sessions: [], truncated: false }, { all: true }))
        .toBe("No Claude Code or Codex sessions found.\n");
});

test("vera import lists this folder, and --all lists every folder", async () => {
    const asked: (string | undefined)[] = [];
    const out = capture();
    const dependencies = {
        stdout: out,
        listImportableSessions: (workspace: string | undefined) => {
            asked.push(workspace);
            return Promise.resolve({ sessions: [], truncated: false });
        },
    } as unknown as Parameters<typeof runCli>[1];
    expect(await runCli(["import"], dependencies)).toBe(0);
    expect(await runCli(["import", "--all"], dependencies)).toBe(0);
    expect(asked).toEqual([process.cwd(), undefined]);
});

test("vera import reports a host it cannot reach", async () => {
    const err = capture();
    const dependencies = {
        stdout: capture(),
        stderr: err,
        listImportableSessions: () => Promise.resolve(undefined),
    } as unknown as Parameters<typeof runCli>[1];
    expect(await runCli(["import"], dependencies)).toBe(1);
    expect(err.text()).toBe("Could not list sessions. Check that the Vera host is running.\n");
});
