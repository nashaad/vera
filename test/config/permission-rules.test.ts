import { expect, test } from "bun:test";
import { homedir } from "node:os";

import { parsePermissionRules } from "../../src/config/permission-rules.ts";

test("permission rules keep their order and allowed outcomes", () => {
    expect(parsePermissionRules([
        { when: { verb: "read", path: "/Users/nash/.aws" }, then: "deny" },
        { when: { operation: "git.push" }, then: "ask" },
        { when: { verb: "write", scope: "workspace" }, then: "allow" },
    ])).toEqual([
        {
            name: "permission_rules.0",
            when: { verb: "read", path: "/Users/nash/.aws" },
            then: "deny",
        },
        {
            name: "permission_rules.1",
            when: { operation: "git.push" },
            then: "ask",
        },
        {
            name: "permission_rules.2",
            when: { verb: "write", scope: "workspace" },
            then: "allow",
        },
    ]);
});

test("permission rules expand a home path and normalize dot segments", () => {
    expect(parsePermissionRules([{
        when: { verb: "read", path: "~/Projects/../.aws" },
        then: "deny",
    }])).toEqual([{
        name: "permission_rules.0",
        when: { verb: "read", path: `${homedir()}/.aws` },
        then: "deny",
    }]);
});

test("permission rules reject review, a non-list, and an empty predicate", () => {
    expect(parsePermissionRules([{
        when: { verb: "read" },
        then: "review",
    }])).toBeUndefined();
    expect(parsePermissionRules({ when: { verb: "read" }, then: "deny" }))
        .toBeUndefined();
    expect(parsePermissionRules([{ when: {}, then: "deny" }]))
        .toBeUndefined();
    expect(parsePermissionRules([{ then: "deny" }])).toBeUndefined();
});

test("permission rules reject a relative path and an unknown outcome", () => {
    expect(parsePermissionRules([{
        when: { verb: "read", path: "secrets" },
        then: "deny",
    }])).toBeUndefined();
    expect(parsePermissionRules([{
        when: { verb: "read" },
        then: "block",
    }])).toBeUndefined();
});

test("an absent list parses as no rules", () => {
    expect(parsePermissionRules(undefined)).toEqual([]);
    expect(parsePermissionRules([])).toEqual([]);
});
