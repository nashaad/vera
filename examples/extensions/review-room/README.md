# Review room (experimental)

This disabled-by-default example proves that a client extension can declare a
different hosted-agent identity without a product-specific branch in the TUI.

Configure this directory as a client extension to enable `/review-room`. It
declares `author` as the primary participant and `critic` as the secondary
participant. It deliberately declares no broadcast alias, uses `ask`
permissions, and requests ephemeral attachment lifetime.
