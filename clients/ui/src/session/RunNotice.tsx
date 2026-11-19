import { ChevronRightIcon, PageIcon } from "../components/Icons.tsx";
import { LinkedText, usePageLinks } from "../pagepane/PageLinks.tsx";
import type { ToolNoticePresentation } from "./model.ts";
import { noticeView } from "./noticeView.ts";

// What a tool run says under its line, shown whether or not the run is opened: a card for a page, else the text.
export function RunNotice({ notice }: { readonly notice: ToolNoticePresentation }) {
    const { annex, open } = usePageLinks();
    const view = noticeView(notice, annex);
    if (view.kind === "text") return <p className="run-notice"><LinkedText text={view.text} /></p>;
    const target = view.open;
    return (
        <button
            type="button"
            className="page-card"
            title={view.title}
            {...(target === undefined ? {} : { "data-page-card": target.path })}
            onClick={() => {
                if (target !== undefined) open(target);
            }}
        >
            <PageIcon className="page-card-icon" />
            <span className="page-card-title">{view.title}</span>
            <ChevronRightIcon className="page-card-chev" />
        </button>
    );
}
