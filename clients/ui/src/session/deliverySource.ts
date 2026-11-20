// The name a delivery card gives an extension: the last part of its id, such as "Artifacts" for vera.artifacts.
export function extensionSourceName(extensionId: string): string {
    const last = extensionId.split(".").at(-1) ?? extensionId;
    const words = last.replace(/[-_]+/g, " ").trim();
    return words === "" ? extensionId : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

const PROCESS_SOURCE_PREFIX = "vera/process/";

// A process notice arrives under an extension source, and its label is the first line of the notice.
function processLabel(source: { readonly sourceAgentId: string; readonly text?: string }): string | undefined {
    if (!source.sourceAgentId.startsWith(PROCESS_SOURCE_PREFIX) || source.text === undefined) return undefined;
    const label = source.text.split("\n", 1)[0]?.trim();
    return label === undefined || label === "" ? undefined : label;
}

// Who a delivery card says it is from. An extension's id is not a session, so only a subagent's
// delivery has a session name to use.
export function deliverySender(source: { readonly fromExtension: boolean; readonly sourceAgentId: string; readonly text?: string }, subagentName: string | undefined): string {
    const label = processLabel(source);
    if (label !== undefined) return label;
    return source.fromExtension ? extensionSourceName(source.sourceAgentId) : subagentName ?? "A subagent";
}
