# vera

A durable, open agent runtime and harness. Use the SDK library and workflow to
script in Python and build your application.

Vera is under heavy development. Try the code, just expect things to move.

## Install

On macOS or Linux, run this in a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/nashaad/vera/main/scripts/install.sh | sh
```

It installs the newest release of the `vera` command under `~/.local`. The
release includes its own runtime, so Bun and Node are not needed. On a Mac the
installer then asks whether to add the desktop app; press Enter to install it
in Applications and open it. Linux gets the `vera` command only.

To install from a checkout instead:

```sh
bun install
bun run install:local
```

Then run `vera` in your project directory, or open the desktop app. See
[Installation and upgrades](docs/installation.md) for versions, updates and
the PATH setup.

## Manual

Start with [Getting started](docs/getting-started.md), or read the manual at
[vera.corvines.com/manual](https://vera.corvines.com/manual/).

## Community

Questions and things you've built: [Discord](https://discord.gg/8svqyjdhS8).

## Contributing

For now, contributions are by invitation. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
