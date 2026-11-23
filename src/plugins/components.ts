import type { PluginMcpServerSource } from "./mcp.ts";

export interface PluginSkillComponent {
    readonly name: string;
    readonly root: string;
    readonly directory: string;
}

export interface PluginAgentComponent {
    readonly name: string;
    readonly path: string;
    readonly root: string;
}

export interface PluginHostComponent {
    readonly id: string;
    readonly version: string;
    readonly capabilities: readonly string[];
    readonly serves_host: boolean;
    readonly directory: string;
    readonly manifest_path: string;
}

export interface PluginDesktopComponent {
    readonly id: string;
    readonly version: string;
    readonly directory: string;
    readonly manifest_path: string;
}

export interface PluginComponents {
    readonly skills: readonly PluginSkillComponent[];
    readonly agents: readonly PluginAgentComponent[];
    readonly mcp_servers: readonly PluginMcpServerSource[];
    readonly host_extension: PluginHostComponent | null;
    readonly desktop_extension: PluginDesktopComponent | null;
}

export interface PluginComponentSummary {
    readonly skills: readonly string[];
    readonly agents: readonly string[];
    readonly mcp_servers: readonly string[];
    readonly host_extension: string | null;
    readonly desktop_extension: string | null;
}

export function summarizePluginComponents(
    components: PluginComponents,
): PluginComponentSummary {
    return {
        skills: components.skills.map((skill) => skill.name),
        agents: components.agents.map((agent) => agent.name),
        mcp_servers: components.mcp_servers
            .filter((server) => server.skipped === undefined)
            .map((server) => server.name),
        host_extension: components.host_extension?.id ?? null,
        desktop_extension: components.desktop_extension?.id ?? null,
    };
}

export function needsHostRestart(summary: PluginComponentSummary): boolean {
    return summary.host_extension !== null || summary.mcp_servers.length > 0;
}

export function needsDesktopRestart(summary: PluginComponentSummary): boolean {
    return summary.desktop_extension !== null;
}

export function pluginSummaryLine(summary: PluginComponentSummary): string {
    const parts = [
        `skills:${summary.skills.length}`,
        `agents:${summary.agents.length}`,
        `mcp:${summary.mcp_servers.length}`,
    ];
    if (summary.host_extension !== null) {
        parts.push(`host:${summary.host_extension}`);
    }
    if (summary.desktop_extension !== null) {
        parts.push(`desktop:${summary.desktop_extension}`);
    }
    return parts.join(" ");
}
