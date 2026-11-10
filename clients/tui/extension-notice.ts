import type { AgentUpdate, NoticeUpdate } from "../../src/engine/protocol.ts";
import type { VeraClientNotice } from "../../src/sdk/extensions.ts";

export type TuiNoticeRenderer = (
    source: string,
    notice: VeraClientNotice,
) => string | undefined;

export function renderedExtensionNotice(
    update: AgentUpdate,
    render: TuiNoticeRenderer | undefined,
): AgentUpdate | undefined {
    if (update.type !== "notice" || update.facts === undefined) return update;
    const { source } = update;
    if (source === undefined || render === undefined) return undefined;
    const text = render(source, { key: update.key, facts: update.facts });
    if (text === undefined) return undefined;
    const rendered: NoticeUpdate = {
        type: "notice",
        key: "extension",
        count: 1,
        text,
        source,
        seq: update.seq,
    };
    return rendered;
}
