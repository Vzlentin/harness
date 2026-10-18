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

This gives you the `harness` command. When `pi` is on your `PATH`, the install also runs `pi install` on the `pi/`
folder of the package, which adds the `subagent` tool, the `/subagent` command and the subagents widget to Pi. Pi and
the `harness` command use the same host. npm hides the output of this step; to see it, add `--foreground-scripts`. When
you install Pi later, or the step fails, run it yourself:

```sh
pi install "$(realpath "$(npm root -g)/@vzlentin/harness/pi")"
```

When you install with `--prefix`, give the same `--prefix` to `npm root -g`.

### Update and remove

```sh
npm install -g @vzlentin/harness@latest
pi remove "$(realpath "$(npm root -g)/@vzlentin/harness/pi")"    # first: npm runs no script on uninstall
npm uninstall -g @vzlentin/harness
```

From 0.1.0, remove the old Pi package first, then install again:

```sh
pi remove npm:@vzlentin/pi-subagent
npm install -g @vzlentin/harness@latest
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
npm run check               # Biome, oxlint, TypeScript, Vitest
XDG_STATE_HOME=/tmp/harness-dev node src/cli.ts list
```

`node src/cli.ts` runs the CLI of this checkout. Give it its own `XDG_STATE_HOME`, so its hosts do not share sockets and
stores with the hosts of the installed `harness`.

The checkout runs from its TypeScript source. `npm publish` builds `dist/` first, and the package contains `dist/`,
the Pi extension in `pi/` and its `postinstall` script. The extension imports `../dist/`, so to try the checkout's
extension in Pi, run `npm run build`, then `pi install ./pi`, and build again after each change in `src/`.
