# harness

Observable, persistent subagents on [Pi](https://github.com/earendil-works/pi)'s libraries and
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Each subagent is a conversation in a durable
host process. You can spawn it, check its status, wait for its answer, steer it, and watch it live in a viewer.

## Install

You need Node.js 22.19 or later, and a login for a model provider in Pi's agent directory (`~/.pi/agent`): log in once
with `/login` in `pi`, or set the API key of the provider, such as `ANTHROPIC_API_KEY`.

```sh
npm install -g @vzlentin/harness
```

This gives you the `harness` command.

### Pi

To also get the `subagent` tool, the `/subagent` command and the subagents widget in Pi:

```sh
pi install npm:@vzlentin/pi-subagent
```

You can add it now or later. Pi and the `harness` command use the same host.

### Update and remove

```sh
npm update -g @vzlentin/harness
pi update                                   # when you installed @vzlentin/pi-subagent
npm uninstall -g @vzlentin/harness
pi remove npm:@vzlentin/pi-subagent
```

## Use

```sh
harness spawn --name review --prompt "Review the current diff"
harness list
harness wait <handle>
harness send <handle> "Focus on error handling"
harness attach <handle>     # live viewer
harness stop <handle>
harness main                # talk to the agent of the main project
```

[docs/spec.md](docs/spec.md) describes all the commands, the tool, the viewer, projects, the host and its state.

## Development

```sh
npm ci
npm run check               # Biome, TypeScript, Vitest
XDG_STATE_HOME=/tmp/harness-dev node src/cli.ts list
```

`node src/cli.ts` runs the CLI of this checkout. Give it its own `XDG_STATE_HOME`, so its hosts do not share sockets and
stores with the hosts of the installed `harness`.

The checkout runs from its TypeScript source. `npm publish` builds `dist/` first, and the package contains only
`dist/`. The Pi plugin is the package in `pi-subagent/`, published from that directory with `npm publish`.
