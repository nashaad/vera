import type { BannerState, Tone } from "../state/connection.ts";
import { ErrorIcon, InfoIcon, WarningIcon } from "./Icons.tsx";

export interface HostBannerProps {
    readonly banner: BannerState;
    readonly onAnswer: (id: string, yes: boolean) => void;
    readonly onReconnect: () => void;
}

function BannerIcon({ tone }: { readonly tone: Tone }) {
    if (tone === "danger") return <ErrorIcon className="banner-icon" />;
    if (tone === "warning") return <WarningIcon className="banner-icon" />;
    return <InfoIcon className="banner-icon" />;
}

export function HostBanner({ banner, onAnswer, onReconnect }: HostBannerProps) {
    return (
        <section
            className="banner"
            data-tone={banner.tone}
            role={banner.tone === "info" ? "status" : "alert"}
        >
            <BannerIcon tone={banner.tone} />
            <div className="banner-text">
                <span className="banner-title">{banner.title}</span>
                <span className="banner-detail">{banner.detail}</span>
            </div>
            <div className="actions">
                {banner.kind === "question" ? (
                    <>
                        <button
                            type="button"
                            className="button button-primary"
                            onClick={() => onAnswer(banner.questionId, true)}
                        >
                            Yes
                        </button>
                        <button
                            type="button"
                            className="button"
                            onClick={() => onAnswer(banner.questionId, false)}
                        >
                            No
                        </button>
                    </>
                ) : (
                    <button type="button" className="button" onClick={onReconnect}>
                        Reconnect
                    </button>
                )}
            </div>
        </section>
    );
}
