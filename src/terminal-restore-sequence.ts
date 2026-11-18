export const TERMINAL_RESTORE_SEQUENCE = "\x1b[?1049l" // main screen
    + "\x1b[?25h" // show cursor
    + "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" // mouse tracking off
    + "\x1b[?2004l" // bracketed paste off
    + "\x1b[<u" // pop kitty keyboard flags
    + "\x1b[0m"; // reset colors and attributes
