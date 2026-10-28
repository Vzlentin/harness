# harness

Observable, persistent (sub)agents on [Pi](https://github.com/earendil-works/pi)'s libraries and
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Each subagent is a conversation in a durable
host process. You can spawn it, check its status, wait for its answer, steer it, and talk to it live in Pi.

## Install

You need Node.js 22.19 or later, and a login for a model provider in Pi's agent directory (`~/.pi/agent`): log in once
with `/login` in `pi`, or set the API key of the provider, such as `ANTHROPIC_API_KEY`.

With Pi:

```sh
pi install npm:@vzlentin/pi-agents
```

This adds the `subagent` tool, the `/subagent` and `/harness` commands and the subagents widget to Pi. Pi installs
`@vzlentin/harness` with it, in its own npm folder, and Pi's tools find the `harness` command. Pi and the `harness`
command use the same host. With [workflows](https://github.com/Vzlentin/workflows), install
`npm:@vzlentin/pi-workflows` instead: it brings pi-agents with it.

For the `harness` command in a terminal, add this line to your shell profile. The folder goes last, because it also
holds the commands of other dependencies, such as an older `pi`:

```sh
export PATH="$PATH:$HOME/.pi/agent/npm/node_modules/.bin"
```

Without Pi, install only the command:

```sh
npm install -g @vzlentin/harness
```

Use one of the two. With both, you get two `harness` commands. When their versions differ, a client refuses the host of the other.

### Update and remove

```sh
pi update --extensions
pi remove npm:@vzlentin/pi-agents
```

Without Pi: `npm install -g @vzlentin/harness@latest` and `npm uninstall -g @vzlentin/harness`.

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

The checkout runs from its TypeScript source. The package contains `dist/`. The Pi extension in `pi/` is the package
`@vzlentin/pi-agents`. To release, merge the release PR `release: <version>` that CI keeps open: CI then publishes both packages at that version. `npm run check` builds `dist/` too, before the type check. The extension
loads `dist/` of its dependency `@vzlentin/harness`. To try the checkout's extension in Pi, link the checkout as that
dependency, then install `pi/`:

```sh
npm run build
mkdir -p pi/node_modules/@vzlentin && ln -s ../../.. pi/node_modules/@vzlentin/harness
pi install ./pi
```

Build again after each change in `src/`.
