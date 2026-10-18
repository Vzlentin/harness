# Harness

A durable agent harness on Pi's libraries and pi-durable. It starts with observable, persistent subagents for independent reviews, investigations, and delegated implementation.

Each subagent is a conversation in one durable host process. The parent can inspect status, wait for durable results, steer active work, and queue follow-ups.

Pi gets the `subagent` tool and the `/subagent` command from a Pi extension that imports this checkout (see [Pi](#pi)).

## Requirements

- Node.js 22.19 or newer
- Pi's agent directory (`~/.pi/agent`) for models, logins, settings, skills and project trust

## Install

[workflows](https://github.com/Vzlentin/workflows) installs harness as a dependency, with the `harness` command and the Pi extension. To install harness alone, add it as a Pi package and put the CLI of that install on `PATH`:

```sh
pi install https://github.com/Vzlentin/harness
ln -sf ~/.pi/agent/git/github.com/Vzlentin/harness/bin/harness.mjs ~/.local/bin/harness
```

The install runs from its TypeScript source. There is no build step. The CLI `bin/harness.mjs` loads `src/cli.ts` through jiti, because Node does not strip types under `node_modules`, where harness is as a dependency. `pi update` updates it. A checkout for development runs only when you run its `bin/harness.mjs`, or load it in Pi.

To try a checkout in Pi without the install, use another Pi agent directory that lists the checkout as a local package, and another state directory, so that its hosts do not share sockets and stores with the installed ones:

```sh
PI_CODING_AGENT_DIR=~/.pi/agent-dev XDG_STATE_HOME=~/.local/state/dev pi
```

## Pi

The package gives Pi the extension `extensions/subagent.ts`: the `subagent` tool, the `/subagent` command and the subagents widget. The extension imports `src/client.ts`, `src/tool.ts`, `src/protocol.ts`, `src/herdr.ts` and `src/trust.ts` of the same install, so Pi and the CLI run the same code and start the same host, from `bin/harness.mjs`. The `subagent` skill is in [Vzlentin/dotfiles](https://github.com/Vzlentin/dotfiles).

## Tool

The `subagent` tool does what the CLI does, with one `action` and its arguments:

| `action` | Arguments |
| --- | --- |
| `spawn` | `name`, `provider`, `model`, `thinking`, `cwd`, `tools`, `prompts`, `files`, `key` |
| `send` | `handle`, `message`, `followUp`, `key` |
| `wait` | `handle`, `timeout` (seconds, default 1800) |
| `status`, `stop` | `handle` |
| `rename` | `handle`, `name` |
| `list` | none |

`tools`, `prompts`, and `files` are arrays. A relative `cwd` or file path is relative to the caller's working directory. A caller without a working directory cannot spawn. The text result is the output of the same CLI command. The structured result is `{ action, value }`, and the tool declares its schema, where `value` is the host's reply: the child for `spawn`, `status`, and `rename`, `{ verb, child }` for `send`, `{ answer }` for `wait`, the children for `list`, and `{ handle, name }` for `stop`. A child is `{ handle, name, state, provider, model, thinking, cwd }`, where `cwd` is its working directory.

A spawn without `provider`, `model`, or `thinking` uses the caller's. A spawn refuses a `thinking` that the model does not have with `<provider>/<model> has no thinking level <level>`. Without `thinking`, the child gets the caller's level, or the nearest level that the model has. A `spawn` or `send` that comes again with the same `key` finds the first one and does not repeat it. Without `key`, the call is the key. Each caller has its own keys. When the call is aborted, for example with Esc, a `wait` stops; the child continues.

`subagent` calls in one message run one after another, in message order, so a `wait` after a `send` waits for the answer to that message. A round with a `subagent` call runs all of its tool calls in order, `bash` and `read` included.

The CLI runs each command as a call of the same tool. There are two other adapters:

- In Pi, the extension gives the tool. The caller is the session ID, the same as `PI_SESSION_ID` for the CLI, so `harness list` in that session shows the tool's children.
- In a pi-durable host, the `piDurable` entry `src/durable-entry.ts` gives the tool. The caller is `<store>:<conversation ID>`, where `<store>` is a random ID that the store keeps. A call that runs again after the host restarts uses the same key, so its spawn or send does not repeat.

The children get the tool too. Their caller is their conversation ID, as for their bash commands.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
harness spawn --name review --prompt "Review the current diff independently"
```

Spawn prints `Spawned <name> (<handle>)` and `State: busy`. Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
harness spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files. The first message holds the text of each file, then `Task:` and the prompts:

```sh
harness spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools with `--tools`, a comma-separated list. Without it, a child gets `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `subagent`, and the tools of installed packages (see Limits). An unknown tool name is an error:

```sh
harness spawn --tools read,bash --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
harness status a1b2c3
harness rename a1b2c3 "error handling review"
harness send a1b2c3 "Focus on error handling"
harness send a1b2c3 --follow-up "Then summarize"
harness wait a1b2c3
harness stop a1b2c3
harness list
harness attach a1b2c3
```

- `status` prints `<name> (<handle>): <state> (<provider>/<model>, <thinking>)`. The state is `busy`, `idle`, or `error` when the last turn failed. After an abort from the viewer, the state is `idle`.
- `send` prints `Prompted`, `Steered`, or `Queued follow-up for`, then the child. A steer goes in after the current tool round. A follow-up starts after the current answer.
- `wait` waits until the child answers its last message, up to `--timeout` seconds (default 1800), and prints `<handle> finished`, a blank line, and the answer. A failed or aborted last turn is an error: after an abort, it prints `<handle> was aborted`.
- `stop` stops the work of the child and of the children it spawned, and removes them.
- `list` prints one line per child of the current caller: `<name> (<handle>)  <state>  <provider>/<model>  <thinking>`.
- `attach` opens the viewer of the child in this terminal (see [Viewer](#viewer)).

### Project agent

Each project has an agent, a conversation in its host that you talk to directly:

```sh
harness web
harness main
```

`harness <project>` opens the viewer of the agent of the project (see [Viewer](#viewer)). It starts the host when none runs. A single word that is not `main`, a project or a command prints the usage. A `--project` before it is an error: `harness <project> takes no --project`.

- The agent works in the project directory, or in the home directory for `main`. Its system prompt, tools and bash env are the same as a child's in that directory (see [Host](#host)). Its bash commands get `PI_SESSION_ID`, the agent's conversation ID.
- When it is first opened, the agent gets Pi's default model (`defaultProvider` and `defaultModel` in Pi's `settings.json`) when it has a login, else the first model with a login, and Pi's `defaultThinkingLevel` (default `medium`), or the nearest level that the model has. Without a model with a login, the viewer does not start and prints `No model for the <project> agent: log in to a provider and set a default model in Pi (defaultProvider and defaultModel)`. The viewer changes its model and thinking level as for a child.
- The children that the agent spawns have the agent as their parent: `harness list` with `PI_SESSION_ID` set to the agent's conversation ID shows them, and a child of such a child is the deepest level.
- Esc stops only the agent's turn. The children that it spawned keep running.
- The agent keeps its conversation across host restarts. `status`, `send`, `wait`, `rename`, `stop` and `list` do not know the agent: it is not a subagent, and it cannot be stopped.

### Projects

Each project has its own host, store and children. A project is a name and a directory:

```sh
harness create web --cwd ~/Dev/web
harness projects
```

- `create <name> --cwd <dir>` prints `Created <name> (<dir>)`, where `<dir>` is the real path of the directory. A relative `--cwd` is relative to the current directory. The name has 1 to 32 characters: `a-z` first, then `a-z`, `0-9` or `-`. It cannot be `main` or a command name. A name that exists, and a directory that does not exist, are errors.
- `projects` prints `<name>  <dir>` for each project, in creation order, then `main`.

The projects are in `$XDG_CONFIG_HOME/harness/projects.json` (default `~/.config/harness/projects.json`), an object of name to directory. A command that reads the file fails when a name does not follow the rule of `create` or a directory is not an absolute path.

A command goes to the project of `--project <name>`, which must come before the command (`harness --project carrefour list`), then of `HARNESS_PROJECT`, then of the current directory: the project with the longest directory that is the current directory or contains it. Without a match, the project is `main`, which has no directory. When two projects have the same directory, the first one created wins. An unknown project name is an error: `Unknown harness project: <name>`. The tool and the viewer find their project in the same way, from `HARNESS_PROJECT` and the current directory of their process.

The caller is `PI_SESSION_ID`, or `cli` when it is not set. `list` shows only the caller's children. The CLI and the tool refuse to `send` to, `rename`, or `stop` a child of another caller. The viewer does not check the caller, because the host socket is for one user: it can show, send to, and abort the child of any caller. The viewer sends text with an `input` request, stops a turn with an `abort` request, and changes the model or the thinking level with a `configure` request. None of these requests has a caller.

`openViewerTab` of `harness/herdr` opens the viewer of a child in a new Herdr tab with the label `<name>` (or the handle), in the child's working directory. The tab runs `env <node> <checkout>/bin/harness.mjs --project <project> attach <handle>`: the viewer with this Node and this checkout's CLI, so it does not need `harness` on `PATH`, on the project of the caller. When `XDG_STATE_HOME` or `XDG_CONFIG_HOME` is set, the tab gets it too. When a `herdr` call fails, it rejects with the stderr of `herdr`, or with the reason that the call failed.

## Viewer

`harness attach <handle>` shows the conversation of one child in the current terminal, live, and sends what you type to it. `harness <project>` shows the project agent in the same viewer. It starts the host when none runs. An unknown handle is an error before the viewer starts.

The viewer is full screen. It draws the conversation with Pi's own components (adapted from the attach view of [mavam/pi-agents](https://github.com/mavam/pi-agents)), from top to bottom:

- The header: `harness │ <name> (<handle>) │ <working directory> │ <state>`, where the state is `◉ busy`, `● idle` or `⊗ error`. When the child is renamed, the header shows the new name. For the project agent, it is `harness │ <project> agent │ <working directory> │ <state>`.
- The transcript: the user messages, the assistant text and thinking, and a Pi tool card for each call of `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`, with its output while it runs. Other tools get Pi's generic card. A compaction shows `[compaction]` and its summary, and a reset shows `[new context]`. New output scrolls into view.
- Pi's working indicator while the child works: `Working...`, `Running <tool>...`, `Compacting (<reason>)...` or `Retrying (attempt <n>): <error>`.
- The queued messages, one line each: `Steer: <first line>` or `Follow-up: <first line>`.
- The editor.
- The footer: `<provider>/<model> · <thinking> │ <tokens> tok $<cost> │ <used>%/<window> ctx` on the left, and `shift+tab thinking · ctrl+l model · ctrl+o expand · ctrl+c exit` on the right. When the terminal is too narrow, the hints go from the first one. The tokens and the cost are the sum of the child's model requests. `<used>` is the prompt and output of the last answer, against the context window of the model; it shows when the host has a login for the model and the child has answered once.

The viewer uses Pi's default theme and keys, not your Pi settings.

| Key | Action |
| --- | --- |
| Enter | Send the message: a steer when the child is busy, a new turn when it is idle |
| Alt+Enter | Send the message as a follow-up |
| Esc | Abort the current turn and withdraw the queued messages, which go back to the editor, steers first. The child stays, with its history, and is `idle`. Does nothing when the child is idle. |
| Shift+Tab | Change the child's thinking level to the next level of its model, after the last one `off` again. The change applies from the next model request |
| Ctrl+L | Pick the child's model from the models with a login. Typing filters the list, as in Pi's model selector; Enter picks, Esc closes. The viewer asks the host for the models each time, so a login after attach shows. The new model keeps the thinking level when it has it, and takes the nearest level it has otherwise |
| Ctrl+O | Show the tool output in full, or collapse it again |
| Shift+↑, Shift+↓ | Scroll the transcript one line |
| Shift+PgUp, Shift+PgDn | Scroll the transcript one page |
| Ctrl+C | Exit and print `<name> (<handle>) keeps running. Reattach: harness attach <handle>`, or `<project> agent keeps running. Reattach: harness <project>` for the project agent. The child continues |

Closing the viewer never changes the child. When the child is stopped, the viewer prints `<name> (<handle>) was stopped` and exits with code 0. When the host closes the connection, the viewer exits with code 1.

In Herdr (`HERDR_ENV` is set), the viewer reports the agent state of its pane, `HERDR_PANE_ID`, at each change: `herdr pane report-agent --source custom:harness --agent <name or handle> --state working|idle --seq <n> <pane> -- env <node> <checkout>/bin/harness.mjs --project <project> attach <handle>`. The resume command is the same command that `openViewerTab` runs. For the project agent, the label is `<project> agent` and the resume command is `env <node> <checkout>/bin/harness.mjs <project>`. A busy child is `working`; an idle child and a child with an error are `idle`. `--seq` increases with each call. The label is the name at the start of the viewer; a rename does not change it. On exit, the viewer calls `herdr pane release-agent`. A failed `herdr` call does not stop the viewer.

## Host

The children of a project run in one host process, `harness --project <name> host` (default `main`). The host takes its project only from `--project`, not from `HARNESS_PROJECT`. The first command that needs it starts it in the background. It exits after 5 minutes with no connection, no running work, and no command other than `list` and `status`. An open viewer is a connection, and a live started task is running work, so each keeps the host running. A task that no installed entry can run, such as one of an entry that was removed, is not running work. The host waits up to 60 s for the lock of `durable.sqlite`, so a client that reads the file, such as the workflows CLI, does not make it fail.

The host keeps its state in `$XDG_STATE_HOME/harness/<project>/` (default `~/.local/state/harness/<project>/`):

- `durable.sqlite`: the children's conversations and records, the started tasks, and the project agent, which is the store's root conversation. Work that a host stop interrupts continues when the host starts again. A host refuses a `durable.sqlite` from a version before the children library: stop the old host, remove the file and run the command again.
- `lock.sqlite`: one host at a time.
- `host.sock`: the socket the CLI, the viewer, and the extension connect to. The protocol has version 6. The `watch` reply is `{ view, child }`. The `models` reply lists the models with a login: `{ provider, id, name, contextWindow, thinkingLevels }`. A `configure` request `{ handle, provider?, model?, thinking? }` replies with the child, and refuses an unknown model and a thinking level that the model does not have. After a `watch` reply, each event of the watch is a `{ "event": ... }` line, and every other line is a reply, in request order. A client refuses a host with another version. When the host is older, stop it with `kill <pid>` and run the command again. When the client is older, reload Pi with `/reload`, or use the CLI of the host's install. The `watch`, `input`, `abort` and `configure` requests take the handle `agent` for the project agent; its info is a child with the handle `agent` and the name `<project> agent`, and its watch never sends `stopped`. Other requests refuse it as an unknown subagent.
- `host.log`: the host's output.

The host loads the `piDurable` entries of the installed packages (see [Limits](#limits)). It calls the default export of each entry with `{ durable, ai, events, children, place }`: the host's pi-durable and pi-ai modules, one event bus that all entries share, the children library, and the host's `place` (store, models and tools) for `children.open`. The entries load before the host opens its store, so `place.store` is usable only once the host is open, which means inside tasks. An entry returns `{ extensions, tasks?, close }`. The host installs `extensions` and `tasks`, and refuses to start when two entries give a task with the same name. An entry that returns no `tasks` loads as before.

A client starts and follows the tasks of the entries with four requests:

- `start { kind, input, key }` creates a task of the kind `kind`, with the input `input`, and replies with its info `{ key, id, kind, version, status, outcome? }`. `version` is the version on the task's record: the version of the entry's task definition that last ran or migrated the task. It shows which version of the entry the host used for this task, not which version the host has loaded now. `outcome` is there only when the task is terminal. The key is the client's own name for the task. A repeated `start` with a known key gives the first task, and its new kind and input are ignored. An unknown kind gives `Unknown task kind: <kind>`. Before it creates the task, `start` sets up the project agent, so a child that the task opens without a model takes the agent's; when the agent has no model, the task still starts.
- `task { key }` replies with the info of the task.
- `wait-task { key }` waits until the task is terminal, and replies with its info, with the outcome. To follow the status during the run, poll `task`.
- `abort-task { key }` aborts the task and the work that it owns, such as the turns of its children, and replies with the info.

The other requests refuse a key that no `start` gave with `Unknown task: <key>`. The host keeps each key and its task in `durable.sqlite`, and no request removes a key, so the key map only grows. A started task is a background task of the root conversation, so an abort of the project agent (Esc in its viewer) does not reach it. A task that a host stop interrupts continues when the host starts again. The children that tasks open are not in `list`, and neither is a subagent that the library closed outside `stop`, such as one under a workflow session whose run ended.

A host from before the projects kept its state in `$XDG_STATE_HOME/harness/`. To keep its children, stop that host, then move `durable.sqlite` and its `-wal` and `-shm` files into `main/` before the `main` host starts.

A child's bash commands get `PI_SESSION_ID` (the child's conversation ID), `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, and `HARNESS_PROJECT`, so a child can spawn its own children with the same configuration, in the same project. A child of a child is the deepest level: a deeper spawn fails with `Nested subagents are disabled`. Children survive `/reload` and the end of the parent Pi session. `harness stop` removes a child and the children it spawned permanently.

A child's system prompt has what a Pi session in the child's working directory gets: the `AGENTS.md` or `CLAUDE.md` of the agent directory and of the working directory and its parents, the skills, and the working directory. User skills always load. Project skills (`.pi/skills`, and `.agents/skills` in the working directory and its parents) load only for a trusted project: a directory without project resources, then the decision saved with `/trust`, then the `defaultProjectTrust` setting, where `ask` counts as not trusted. A trust decision that a Pi session made for itself without saving it does not reach its children; when the tool spawns in such a session, it adds `The child gets no project skills (.pi/skills, .agents/skills): this project is trusted for this Pi session only, and children see only the trust saved for future sessions. To give children project skills, run /trust and choose Trust.` to its output. The host checks the trust on every model request, so a decision saved later applies from the next request. The host reads the instructions and skills of a directory once per trust decision and keeps them until it exits. It skips packages that are not installed. When the instructions or skills of a directory fail to load, the child gets none for that request, the host writes a warning, and the next request tries again.

## Limits

- Children get only `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `subagent`, and the `piDurable` tools of installed packages. The host does not load the `piDurable` entry of its own package directory, because it gives its children the tool with their own caller. They get no MCP tools and no other Pi extensions. The host runs through `bin/harness.mjs`, so jiti loads the entries, also those of packages installed with npm.
- A change to `AGENTS.md` or to a skill reaches children only after the host restarts.
- `--file` gives text only; images are not attached.
- The CLI sends each `spawn` once and has no `key`. If the host stops during a `spawn` and you run the command again, there can be two children.
