import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TUI = join(import.meta.dir, "..", "..", "clients", "tui");

/** Source from a top-level declaration to its closing brace at column 0. */
function topLevelBlock(source: string, opening: string): string {
    const start = source.indexOf(opening);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

const startConfiguredTui = topLevelBlock(
    readFileSync(join(TUI, "main.ts"), "utf8"),
    "export async function startConfiguredTui(",
);

test("every host request in startConfiguredTui goes through the build check", () => {
    const uses = [...startConfiguredTui.matchAll(/^.*host\.socket_path.*$/gm)].map((match) => match[0].trim());
    expect(uses).toEqual([
        "const pairedSocket = (): Promise<string> => pairedHostSocket(host.socket_path, clientBuildId);",
        "const agentClients = createConfiguredTuiAgentClients(() => host.socket_path, clientBuildId);",
    ]);
});

test("Reconnect host checks the build before it can dispatch to another release", () => {
    const start = startConfiguredTui.indexOf("reconnectSession:");
    expect(start).toBeGreaterThan(-1);
    const reconnect = startConfiguredTui.slice(start);
    const check = reconnect.indexOf("await refuseOtherHostBuild(clientBuildId);");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(reconnect.indexOf("findOrStartResidentHost("));
});

test("diagnostics read the host startConfiguredTui is attached to now", () => {
    expect(startConfiguredTui).toContain("get hostBuildId() { return host.build_id; },");
    expect(startConfiguredTui).toContain("get hostPid() { return host.pid; },");
    expect(startConfiguredTui).toContain("get hostStartedAt() { return host.started_at; },");
    expect(startConfiguredTui).not.toMatch(/hostPid: host\.pid|hostBuildId: host\.build_id/);
});

test("every one-shot request in the agent client factory goes through the build check", () => {
    const factory = topLevelBlock(
        readFileSync(join(TUI, "configured-agent-client.ts"), "utf8"),
        "export function createConfiguredTuiAgentClients(",
    );
    const uses = [...factory.matchAll(/^.*socketPath\(\).*$/gm)].map((match) => match[0].trim());
    expect(uses).toEqual([
        "const pairedSocket = () => pairedHostSocket(socketPath(), buildId);",
    ]);
});
