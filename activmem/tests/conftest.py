import os

# Word-only tests stay offline. Seafood and startup opt in.
os.environ.setdefault("ACTIVMEM_EMBED", "0")
