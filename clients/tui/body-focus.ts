export class TuiBodyFocusController {
    private dragged = false;

    noteDrag(): void {
        this.dragged = true;
    }

    release(blocked: boolean): boolean {
        const shouldFocus = !this.dragged && !blocked;
        this.dragged = false;
        return shouldFocus;
    }
}
