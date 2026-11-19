export interface PageCaptureDetails {
    readonly tag: string;
    readonly selector: string;
    readonly text: string;
    readonly styles: string;
    readonly html: string;
    readonly siblings: string;
}

export interface PageCapture {
    readonly path: string;
    readonly preview: string;
    readonly text: string;
    readonly details?: PageCaptureDetails;
}
