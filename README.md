# harness

Observable, persistent (sub)agents on [Pi](https://github.com/earendil-works/pi)'s libraries and
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Each subagent is a conversation in a durable
host process. You can spawn it, check its status, wait for its answer, steer it, and talk to it live in Pi.

## Install

You need Node.js 22.19 or later, and a login for a model provider in Pi's agent directory (`~/.pi/agent`): log in once
with `/login` in `pi`, or set the API key of the provider, such as `ANTHROPIC_API_KEY`.

```sh
npm install -g @vzlentin/harness
```

This works with npm 11 and npm 12. It gives you the `harness` command, and a setup runs `pi install` on
`npm:@vzlentin/pi-agents` at the same version, which adds the `subagent` tool, the `/subagent` and `/harness` commands
and the subagents widget to Pi. Pi and the `harness` command use the same host. npm 12 runs no install script by default, so there the first
`harness` command does the setup. When `pi` is not on your `PATH`, or the step fails, the setup prints the command to run later:

```sh
pi install "npm:@vzlentin/pi-agents@$(harness --version)"
```

### Update and remove

```sh
npm install -g @vzlentin/harness@latest
pi remove npm:@vzlentin/pi-agents    # npm runs no script on uninstall
npm uninstall -g @vzlentin/harness
```

## Use

```sh
harness spawn --name review --prompt "Review the current diff"
harness list
harness wait <handle>
harness send <handle> "Focus on error handling"
harness attach <handle>     # open it in Pi
harness stop <handle>
harness main                # open the agent of the main project in Pi
```

In Pi, `/harness <project>` opens a session that shows the agent of the project in Pi's own chat, and sends what you
type to it. Without a project, it asks for one. `pi --harness <project>` starts Pi in such a session.

[docs/spec.md](docs/spec.md) describes all the commands, the tool, the Pi extension, projects, the host and its state.

## Development

```sh
npm ci
npm run check               # Biome, oxlint, TypeScript, Vitest
XDG_STATE_HOME=/tmp/harness-dev node src/cli.ts list
```

`node src/cli.ts` runs the CLI of this checkout. Give it its own `XDG_STATE_HOME`, so its hosts do not share sockets and
stores with the hosts of the installed `harness`.

The checkout runs from its TypeScript source. The package contains `dist/` and its `postinstall` script. The Pi
extension in `pi/` is the package `@vzlentin/pi-agents`. To release, merge the release PR `release: <version>` that CI keeps open: CI then publishes that version. `npm run check` builds `dist/` too, before the type check. The extension
loads `dist/` of the global harness, so to try the checkout's extension in Pi, run `npm run build`, `npm link`, then
`pi install ./pi`, and build again after each change in `src/`.
