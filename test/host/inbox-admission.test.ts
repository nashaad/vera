import { describe, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    InboxAdmissionPolicy,
    inboxSourceFamily,
    loadProjectInboxAdmission,
} from "../../src/host/inbox-admission.ts";
import { loadVeraConfig } from "../../src/config.ts";

describe("inbox admission", () => {
    test("derives a stable family without reading payloads", () => {
        expect(inboxSourceFamily({
            source: "watch/git",
            kind: "filesystem.changed",
        })).toBe("filesystem");
        expect(inboxSourceFamily({
            source: "vera.arc/main",
            kind: "post",
        })).toBe("arc");
    });

    test("persists user admission in the real config writer", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-inbox-admission-"));
        const path = join(root, "config.json");
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
        }));
        try {
            const policy = new InboxAdmissionPolicy({
                user: [],
                userConfigPath: path,
            });
            await policy.remember("arc", "user");

            expect(loadVeraConfig({ path }).inbox).toEqual({
                admit: ["arc"],
            });
            expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty(
                "inbox.admit",
                ["arc"],
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("project admission extends existing project config", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-inbox-project-"));
        const configDirectory = join(root, ".vera");
        const path = join(configDirectory, "config.json");
        try {
            // The policy writer must preserve project-owned settings.
            mkdirSync(configDirectory, { recursive: true });
            writeFileSync(path, JSON.stringify({
                project_name: "vera",
                inbox: { admit: ["filesystem"] },
            }));
            const policy = new InboxAdmissionPolicy({
                user: ["arc"],
                projectRoot: root,
            });
            await policy.remember("git", "project");

            expect(loadProjectInboxAdmission(root)).toEqual([
                "filesystem",
                "git",
            ]);
            expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
                project_name: "vera",
                inbox: { admit: ["filesystem", "git"] },
            });
            expect(policy.allows("arc")).toBe(true);
            expect(policy.allows("filesystem")).toBe(true);
            expect(policy.allows("git")).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("does not replace a malformed project inbox config", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-inbox-project-invalid-"));
        const configDirectory = join(root, ".vera");
        const path = join(configDirectory, "config.json");
        mkdirSync(configDirectory, { recursive: true });
        const original = JSON.stringify({ inbox: "invalid" });
        writeFileSync(path, original);
        try {
            const policy = new InboxAdmissionPolicy({
                user: [],
                projectRoot: root,
            });

            await expect(policy.remember("arc", "project")).rejects.toThrow(
                "invalid inbox config",
            );
            expect(readFileSync(path, "utf8")).toBe(original);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("serializes concurrent remembers without duplicate families", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-inbox-admission-race-"));
        const path = join(root, "config.json");
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            inbox: { admit: [] },
        }));
        try {
            const first = new InboxAdmissionPolicy({
                user: [],
                userConfigPath: path,
            });
            const second = new InboxAdmissionPolicy({
                user: [],
                userConfigPath: path,
            });
            await Promise.all([
                first.remember("arc", "user"),
                second.remember("arc", "user"),
            ]);

            expect(loadVeraConfig({ path }).inbox).toEqual({
                admit: ["arc"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("merges an external user edit made after policy construction", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-inbox-admission-edit-"));
        const path = join(root, "config.json");
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            inbox: { admit: ["arc"] },
        }));
        try {
            const policy = new InboxAdmissionPolicy({
                user: ["arc"],
                userConfigPath: path,
            });
            writeFileSync(path, JSON.stringify({
                schema_version: 1,
                model: "anthropic/example-model",
                inbox: { admit: ["filesystem"] },
            }));

            await policy.remember("schedule", "user");

            expect(loadVeraConfig({ path }).inbox).toEqual({
                admit: ["filesystem", "schedule"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("keeps project admission scoped to the policy workspace", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-inbox-project-scope-"));
        const first = join(root, "first");
        const second = join(root, "second");
        mkdirSync(join(first, ".vera"), { recursive: true });
        mkdirSync(join(second, ".vera"), { recursive: true });
        writeFileSync(join(first, ".vera", "config.json"), JSON.stringify({
            inbox: { admit: ["filesystem"] },
        }));
        writeFileSync(join(second, ".vera", "config.json"), JSON.stringify({
            inbox: { admit: [] },
        }));
        try {
            const firstPolicy = new InboxAdmissionPolicy({
                user: [],
                projectRoot: first,
            });
            const secondPolicy = new InboxAdmissionPolicy({
                user: [],
                projectRoot: second,
            });

            expect(firstPolicy.allows("filesystem")).toBe(true);
            expect(secondPolicy.allows("filesystem")).toBe(false);
            await secondPolicy.remember("schedule", "project");

            expect(loadProjectInboxAdmission(first)).toEqual(["filesystem"]);
            expect(loadProjectInboxAdmission(second)).toEqual(["schedule"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
