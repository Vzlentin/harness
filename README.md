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

This adds the `subagent` tool, the `subagent` skill, the `/subagent`, `/todo`, `/harness` and `/vc` commands, the
subagents and todo widgets and the tools bridge in the IPython kernels of pi-ipython to Pi. Pi installs
`@vzlentin/harness` with it, in its own npm folder, and Pi's tools find the `harness` command. Pi and the `harness`
command use the same host. With
[workflows](https://github.com/Vzlentin/workflows), install `npm:@vzlentin/pi-workflows` instead: it brings pi-agents
with it.

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
harness query <handle> "Which files did it change?"  # ask a model about its transcript
harness attach <handle>     # open it in Pi
harness serve <folder>      # serve a folder on the web server of the host; its Send posts to you
harness stop <handle>
harness todo add <text>     # add a todo to your list (todo list, todo set <id> <state>)
harness tree                # print the agents and the runs of the host, with their todos
harness main                # open the agent of the main host in Pi
```

In Pi, `/harness <host>` opens a session that shows the agent of the host in Pi's own chat, and sends what you type
to it. Without a host, it asks for one. `pi --harness <host>` starts Pi in such a session.

In Pi, `/todo <text>` adds a todo to the session's list. `/todo` alone asks for the text.

In Pi, `/vc` (or `ctrl+shift+y`) selects a block of the agent messages, such as a code block, and copies it.

When the directory of a host has a `.optmem` folder, the agents of the host get it as their memory (`MEMORY_DIR`).

The rules, the gate, the parleys, the work items, the digest and the memory of the host agent come from the projects
entry, a separate package. A host without it runs the agents with none of them.

Before your input, the agent of a host gets a short catch-up: the workflows runs that ended and the new commits on
the default branch since its last input.

[docs/spec.md](docs/spec.md) describes all the commands, the tool, the Pi extension, the hosts, the host process and
its state.

## Development

```sh
npm ci
npm run check               # vp pack, vp check, tsc, vp test
XDG_STATE_HOME=/tmp/harness-dev node src/cli.ts list
```

`node src/cli.ts` runs the CLI of this checkout. Give it its own `XDG_STATE_HOME`, so its hosts do not share sockets and
stores with the hosts of the installed `harness`.

The checkout runs from its TypeScript source. The package contains `dist/`. The Pi extension in `pi/` is the package
`@vzlentin/pi-agents`. To release, merge the release PR `release: <version>` that CI keeps open: CI then publishes both packages at that version. `npm run check` builds `dist/` too, before the lint and the type checks. The extension
loads `dist/` of its dependency `@vzlentin/harness`. To try the checkout's extension in Pi, link the checkout as that
dependency, then install `pi/`:

```sh
npm run build
mkdir -p pi/node_modules/@vzlentin && ln -s ../../.. pi/node_modules/@vzlentin/harness
pi install ./pi
```

Build again after each change in `src/`.
