import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    parseFolderCustomizations,
    readFolderCustomizations,
    RESTART_TO_READ,
} from "../../clients/desktop/src/customization-requests.ts";
import { socketTest } from "../support/socket-probe.ts";

const READING = {
    type: "folder_customizations",
    skills: {
        skills: [
            { name: "nest-check", description: "Checks the nest", disableModelInvocation: true },
            { name: "mast-watch", description: "Looks from the mast", disableModelInvocation: false },
        ],
        warnings: ["Skipped broken skill"],
    },
    agents: {
        starts_on: "default",
        agents: [
            { name: "default", scope: "extension", writable: false },
            { name: "plan", scope: "project", writable: true, description: "Plans before it edits" },
        ],
        notices: ["Skipped broken.md"],
    },
    sources: {
        sources: [
            { id: "skills:nest-check", category: "skills", name: "nest-check", description: "Checks the nest", scope: "project", path: "/nest/.vera/skills/nest-check/SKILL.md", content: "Body", editable: true, status: "available" },
        ],
        warnings: ["Skipped broken skill", "Skipped broken.md"],
    },
};

describe("the host's reading", () => {
    test("@core a reading carries the skills, the agents, the sources and each warning once", () => {
        const parsed = parseFolderCustomizations(READING);
        expect(parsed).toMatchObject({ ok: true, startsOn: "default" });
        if (parsed === undefined || !parsed.ok) throw new Error("not read");
        expect(parsed.skills).toEqual([
            { name: "nest-check", description: "Checks the nest", manualOnly: true },
            { name: "mast-watch", description: "Looks from the mast", manualOnly: false },
        ]);
        expect(parsed.agents.map((agent) => agent.name)).toEqual(["default", "plan"]);
        expect(parsed.sources.map((source) => source.id)).toEqual(["skills:nest-check"]);
        expect(parsed.warnings).toEqual(["Skipped broken skill", "Skipped broken.md"]);
    });

    test("entries this window cannot read are dropped, and long lists and texts are cut", () => {
        const many = Array.from({ length: 700 }, (_, index) => ({ name: `skill-${index}`, description: "" }));
        const long = "x".repeat(30_000);
        const parsed = parseFolderCustomizations({
            ...READING,
            skills: { skills: [...many, { name: 7 }, "crow"], warnings: Array.from({ length: 80 }, (_, index) => `warning ${index}`) },
            sources: { sources: [{ ...READING.sources.sources[0], content: long }, { id: 3 }], warnings: [] },
        });
        if (parsed === undefined || !parsed.ok) throw new Error("not read");
        expect(parsed.skills).toHaveLength(500);
        expect(parsed.sources).toHaveLength(1);
        expect(parsed.sources[0]?.content).toHaveLength(20_000);
        expect(parsed.warnings.length).toBeLessThanOrEqual(50);
    });

    test("@core anything else is refused", () => {
        for (const reply of [
            undefined,
            null,
            "reading",
            [],
            { type: "protocol_error" },
            { ...READING, type: "new_session_agents" },
            { ...READING, skills: [] },
            { ...READING, skills: { warnings: [] } },
            { ...READING, agents: { ...READING.agents, starts_on: "" } },
            { ...READING, agents: { ...READING.agents, agents: "plan" } },
            { ...READING, sources: { sources: {}, warnings: [] } },
            { type: "folder_customizations" },
        ]) {
            expect(parseFolderCustomizations(reply)).toBeUndefined();
        }
    });
});

describe("asking the host", () => {
    test("no host socket means no reading", async () => {
        expect(await readFolderCustomizations(undefined, "/nest")).toEqual({ ok: false, reason: "The host is not running." });
    });

    socketTest("@core a host that closes the connection on this request, as an older one does, reads as needing a restart", async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-old-host-"));
        const socketPath = join(root, "old.sock");
        const server = createServer((socket) => {
            socket.on("data", () => socket.destroy());
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, resolve);
            });
            expect(await readFolderCustomizations(socketPath, undefined)).toEqual({ ok: false, reason: RESTART_TO_READ });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
        }
    });
});
