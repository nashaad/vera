import { expect, test } from "bun:test";

import { parsePermissions } from "../../clients/ui/src/session/permissions.ts";
import { renderPermissionInspection } from "../../clients/tui/permission-inspection.ts";
import type { PermissionInspection } from "../../src/engine/permissions.ts";
import { sandboxInspectionLine } from "../../src/sandbox/inspection.ts";
import type { SandboxInspection } from "../../src/sdk/sandbox.ts";

const active: SandboxInspection = {
    enabled: true,
    status: "active",
    network: "open",
    allowedDomains: [],
};

function inspection(sandbox: SandboxInspection | undefined): PermissionInspection {
    return {
        selected: { name: "auto", rules: [], defaultOutcome: "ask" },
        availableModes: ["auto", "full_access"],
        activeGrants: [],
        ...(sandbox === undefined ? {} : { sandbox }),
    };
}

test("@core the sandbox line covers every state", () => {
    expect(sandboxInspectionLine(undefined, "auto")).toBe("Sandbox: off");
    expect(sandboxInspectionLine({ ...active, enabled: false }, "auto"))
        .toBe("Sandbox: off");
    expect(sandboxInspectionLine(active, "auto"))
        .toBe("Sandbox: on, network open");
    expect(sandboxInspectionLine({
        ...active,
        network: "allowlist",
        allowedDomains: ["github.com", "*.example.com"],
    }, "auto")).toBe("Sandbox: on, network allowlist (2 hosts)");
    expect(sandboxInspectionLine(active, "full_access"))
        .toBe("Sandbox: on, not applied in full_access");
    expect(sandboxInspectionLine({
        ...active,
        status: "unavailable",
        reason: "not supported on aix",
    }, "auto")).toBe(
        "Sandbox: unavailable (not supported on aix), commands run unsandboxed",
    );
});

test("@core the terminal shows the sandbox line in /permissions", () => {
    const rendered = renderPermissionInspection(inspection(active));
    expect(rendered).toContain("Sandbox: on, network open");
    expect(renderPermissionInspection(inspection(undefined)))
        .toContain("Sandbox: off");
});

test("@core the desktop parses the sandbox line in /permissions", () => {
    const parsed = parsePermissions({
        mode: "auto",
        pending: false,
        inspection: {
            selected: { name: "auto", rules: [], defaultOutcome: "ask" },
            availableModes: ["auto"],
            activeGrants: [],
            sandbox: {
                enabled: true,
                status: "active",
                network: "allowlist",
                allowedDomains: ["github.com"],
            },
        },
    });
    expect(parsed?.sandbox).toEqual({
        enabled: true,
        status: "active",
        network: "allowlist",
        allowedDomains: ["github.com"],
    });
    expect(parsed?.sandbox).toBeDefined();
    if (parsed?.sandbox === undefined) return;
    expect(sandboxInspectionLine(parsed.sandbox, parsed.mode))
        .toBe("Sandbox: on, network allowlist (1 hosts)");
});

test("@core the desktop ignores a malformed sandbox field", () => {
    const parsed = parsePermissions({
        mode: "auto",
        pending: false,
        inspection: {
            availableModes: ["auto"],
            activeGrants: [],
            sandbox: { enabled: true, status: "on" },
        },
    });
    expect(parsed?.sandbox).toBeUndefined();
});
