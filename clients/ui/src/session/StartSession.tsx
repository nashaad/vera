export interface StartSessionButtonProps {
    readonly onStart: () => void;
}

export function StartSessionButton({ onStart }: StartSessionButtonProps) {
    return (
        <button type="button" className="ghost-btn" data-start-session onClick={onStart}>
            Start session
        </button>
    );
}

export interface StartOfferProps {
    readonly text: string;
    readonly onStart: () => void;
}

// A right-pane view that cannot show anything until the session runs says so and offers the start.
export function StartOffer({ text, onStart }: StartOfferProps) {
    return (
        <div className="start-offer" data-start-offer>
            <p className="view-empty">{text}</p>
            <StartSessionButton onStart={onStart} />
        </div>
    );
}
