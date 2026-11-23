// A home with sample sessions in three folders, for sidebar layout and screenshot checks.
// The records are real session headers, so the host lists and opens them like any other session.

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SAMPLE = {
    usage: "usage-audit",
    trace: "trace-missing-usage",
    server: "server-side-buckets",
    child: "bucket-query",
    stopcard: "stopcard",
    nebatch: "nebatch",
};

// Usage audit and Trace share usechart, so the folder keeps its heading; stopcard and
// nebatch each hold one top-level session whose label matches the folder, so each is one row.
const SESSIONS = [
    { id: SAMPLE.usage, folder: "usechart", title: "Usage audit", age: 5 * 60_000 },
    { id: SAMPLE.trace, folder: "usechart", title: "Trace missing usage", age: 0 },
    { id: "fix-unpriced-usage", folder: "usechart", title: "Fix unpriced usage", parent: SAMPLE.trace, age: 60_000 },
    { id: "annex-client-changes", folder: "usechart", title: "Annex client changes", parent: SAMPLE.trace, age: 2 * 60_000 },
    { id: "resume-server-bucketing", folder: "usechart", title: "Resume server bucketing", parent: SAMPLE.trace, age: 3 * 60_000 },
    { id: SAMPLE.server, folder: "usechart", title: "Server-side buckets", parent: SAMPLE.trace, age: 4 * 60_000 },
    { id: SAMPLE.child, folder: "usechart", title: "Bucket query", parent: SAMPLE.server, age: 5 * 60_000 },
    { id: SAMPLE.stopcard, folder: "stopcard", title: "stopcard", age: 60 * 60_000 },
    ...Array.from({ length: 9 }, (_, index) => ({
        id: `stopcard-step-${index + 1}`,
        folder: "stopcard",
        title: `Stop card step ${index + 1}`,
        parent: SAMPLE.stopcard,
        age: (60 + index) * 60_000,
    })),
    { id: SAMPLE.nebatch, folder: "nebatch", title: "nebatch", age: 3 * 60 * 60_000 },
];

// `pins` is the ordered pin list; `grouping` is written to the desktop's settings file.
export function seedSidebarSample(home, { pins = [SAMPLE.usage], grouping = "none" } = {}) {
    const folderRoot = join(home, "..", "sample");
    const sessionRoot = join(home, "runtime", "sessions");
    mkdirSync(sessionRoot, { recursive: true });
    const now = Date.now();
    for (const session of SESSIONS) {
        const folder = join(folderRoot, session.folder);
        mkdirSync(folder, { recursive: true });
        const path = join(sessionRoot, `${session.id}.jsonl`);
        mkdirSync(dirname(path), { recursive: true });
        const header = {
            type: "session",
            version: 1,
            id: session.id,
            timestamp: new Date(now - session.age - 60_000).toISOString(),
            cwd: folder,
            ...(session.parent === undefined ? {} : { parentId: session.parent }),
        };
        const name = {
            type: "session_name",
            timestamp: new Date(now - session.age - 45_000).toISOString(),
            name: session.title,
        };
        const message = {
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: new Date(now - session.age - 30_000).toISOString(),
            message: { role: "user", content: [{ type: "text", text: `About ${session.title}` }] },
        };
        writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(name)}\n${JSON.stringify(message)}\n`);
        const stamp = new Date(now - session.age);
        utimesSync(path, stamp, stamp);
    }
    const machine = join(home, "machine", "desktop");
    mkdirSync(machine, { recursive: true });
    writeFileSync(join(machine, "pins.json"), `${JSON.stringify({ sessions: pins })}\n`);
    writeFileSync(join(machine, "sidebar.json"), `${JSON.stringify({ groupBy: grouping })}\n`);
}
