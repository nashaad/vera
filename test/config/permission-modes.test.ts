import { expect, test } from "bun:test";

import { parsePermissionModes } from "../../src/config/permission-modes.ts";

const reviewers = { careful: {} };

test("custom permission modes preserve ordered declarative rules", () => {
    expect(parsePermissionModes({
        unattended: {
            default: "review",
            reviewer_profile: "careful",
            rules: [
                {
                    when: { verb: "read" },
                    then: "allow",
                },
                {
                    when: { verb: "write", scope: "workspace" },
                    then: "allow",
                },
                {
                    when: { operation: "git.*" },
                    then: "review",
                },
            ],
        },
    }, reviewers)).toEqual({
        unattended: {
            name: "unattended",
            defaultOutcome: "review",
            reviewerProfile: "careful",
            rules: [
                {
                    name: "unattended.rules.0",
                    when: { verb: "read" },
                    then: "allow",
                },
                {
                    name: "unattended.rules.1",
                    when: { verb: "write", scope: "workspace" },
                    then: "allow",
                },
                {
                    name: "unattended.rules.2",
                    when: { operation: "git.*" },
                    then: "review",
                },
            ],
        },
    });
});

test("legacy claim-shaped rules migrate only when the meaning is preserved", () => {
    const migrated = parsePermissionModes({
        legacy: {
            default: "allow",
            rules: [
                { when: { capability: "delete" }, then: "ask" },
                { when: { capability: "write", path_scope: "workspace" }, then: "allow" },
            ],
        },
    }, reviewers);
    expect(migrated?.legacy?.rules.map((rule) => rule.when)).toEqual([
        { verb: "delete" },
        { verb: "write", scope: "workspace" },
    ]);

    for (
        const when of [
            { capability: "write", confidence: "exact" },
            { capability: "delete", recursive: true },
            { capability: "network" },
            { capability: "execute" },
        ]
    ) {
        expect(parsePermissionModes({
            legacy: { default: "allow", rules: [{ when, then: "ask" }] },
        }, reviewers)).toBeUndefined();
    }
});

test("config rules accept a snake_case path_glob, parsed as pathGlob", () => {
    const parsed = parsePermissionModes({
        no_secrets: {
            default: "allow",
            rules: [{
                when: { path_glob: "*.key" },
                then: "deny",
            }],
        },
    }, reviewers);
    expect(parsed?.no_secrets?.rules).toEqual([{
        name: "no_secrets.rules.0",
        when: { pathGlob: "*.key" },
        then: "deny",
    }]);
});

test("modes reject unknown operations and reviewer references", () => {
    expect(parsePermissionModes({
        broken: {
            default: "allow",
            rules: [{
                when: { operation: "deploy.production" },
                then: "ask",
            }],
        },
    }, reviewers)).toBeUndefined();
    expect(parsePermissionModes({
        broken: {
            default: "review",
            reviewer_profile: "missing",
            rules: [],
        },
    }, reviewers)).toBeUndefined();
});

test("review outcomes require exactly one reviewer profile", () => {
    expect(parsePermissionModes({
        missing: {
            default: "review",
            rules: [],
        },
    }, reviewers)).toBeUndefined();
    expect(parsePermissionModes({
        unused: {
            default: "allow",
            reviewer_profile: "careful",
            rules: [],
        },
    }, reviewers)).toBeUndefined();
});

test("custom modes cannot replace built-in names", () => {
    for (const name of ["ask", "auto", "full_access"]) {
        expect(parsePermissionModes({
            [name]: {
                default: "allow",
                rules: [],
            },
        }, reviewers)).toBeUndefined();
    }
});
