const MARKS: readonly { readonly glyph: string; readonly name: string; readonly text: string }[] = [
    { glyph: "WA", name: "WA score", text: "A WebDev Arena rating from blind head-to-head votes. Higher wins more often." },
    {
        glyph: "$/M",
        name: "Blended rate",
        text: "Dollars per million tokens, weighted 3 input to 1 output. Vera computes it the same way for every model.",
    },
    { glyph: "P", name: "Front", text: "Marks a model with the best score for its price among the models on offer." },
    { glyph: "Image", name: "Images", text: "Marks a model that accepts an image in a message." },
    { glyph: "Pin", name: "Shortlist", text: "Pinned models are on your shortlist and offered first in the composer." },
    { glyph: "Verified", name: "Verified", text: "The model answered a probe. A model that has not been probed is taken on the provider's listing." },
    { glyph: "Probe", name: "Probe", text: "Sends one short request to check that the model answers, and reports the result." },
];

export function HelpTab() {
    return (
        <div className="models-plain">
            {MARKS.map((mark) => (
                <div className="models-mark" key={mark.name}>
                    <span className="models-mark-glyph">{mark.glyph}</span>
                    <span>
                        <span className="models-mark-name">{mark.name}</span>
                        <span className="models-mark-text">{mark.text}</span>
                    </span>
                </div>
            ))}
        </div>
    );
}
