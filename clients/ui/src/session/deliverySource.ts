// The name a delivery card gives an extension: the last part of its id, such as "Artifacts" for vera.artifacts.
export function extensionSourceName(extensionId: string): string {
    const last = extensionId.split(".").at(-1) ?? extensionId;
    const words = last.replace(/[-_]+/g, " ").trim();
    return words === "" ? extensionId : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

// Who a delivery card says it is from. An extension's id is not a session, so only a subagent's
// delivery has a session name to use.
export function deliverySender(source: { readonly fromExtension: boolean; readonly sourceAgentId: string }, subagentName: string | undefined): string {
    return source.fromExtension ? extensionSourceName(source.sourceAgentId) : subagentName ?? "A subagent";
}
