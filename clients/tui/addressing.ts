
export function renderTuiHeldAddress(
    name: string | undefined,
): { facts: string; keys: string } {
    if (name === undefined || name.trim().length === 0) {
        return { facts: "", keys: "" };
    }
    return {
        facts: `every message goes to ${name.trim()}`,
        keys: "@vera goes back to the agent",
    };
}
