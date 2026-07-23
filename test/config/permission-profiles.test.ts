import { expect, test } from "bun:test";

import { parsePermissionProfiles } from "../../src/config/permission-profiles.ts";

const reviewers = { careful: {} };

test("custom permission profiles preserve ordered declarative rules", () => {
    expect(parsePermissionProfiles({
        unattended: {
            default: "review",
            reviewer_profile: "careful",
            rules: [
                {
                    when: { capability: "read" },
                    then: "allow",
                },
                {
                    when: {
                        capability: "write",
                        confidence: "exact",
                        path_scope: "workspace",
                    },
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
                    when: { capability: "read" },
                    then: "allow",
                },
                {
                    name: "unattended.rules.1",
                    when: {
                        capability: "write",
                        confidence: "exact",
                        pathScope: "workspace",
                    },
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

test("profiles reject unknown operations and reviewer references", () => {
    expect(parsePermissionProfiles({
        broken: {
            default: "allow",
            rules: [{
                when: { operation: "deploy.production" },
                then: "ask",
            }],
        },
    }, reviewers)).toBeUndefined();
    expect(parsePermissionProfiles({
        broken: {
            default: "review",
            reviewer_profile: "missing",
            rules: [],
        },
    }, reviewers)).toBeUndefined();
});

test("review outcomes require exactly one reviewer profile", () => {
    expect(parsePermissionProfiles({
        missing: {
            default: "review",
            rules: [],
        },
    }, reviewers)).toBeUndefined();
    expect(parsePermissionProfiles({
        unused: {
            default: "allow",
            reviewer_profile: "careful",
            rules: [],
        },
    }, reviewers)).toBeUndefined();
});

test("custom profiles cannot replace built-in names", () => {
    for (const name of ["ask", "auto", "full_access"]) {
        expect(parsePermissionProfiles({
            [name]: {
                default: "allow",
                rules: [],
            },
        }, reviewers)).toBeUndefined();
    }
});
