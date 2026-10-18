# harness reference

The behaviour of the `harness` CLI, the `subagent` tool, the Pi extension and the host. The [README](../README.md) has the install.

## Commands

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

Restrict tools with `--tools`, a comma-separated list. Without it, a child gets `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `subagent`, and the tools of the host's entries (see [Limits](#limits)). An unknown tool name is an error:

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

- `status` prints `<name> (<handle>): <state> (<provider>/<model>, <thinking>)`. The state is `busy`, `idle`, or `error` when the last turn failed. After an abort from a mirror session, the state is `idle`.
- `send` prints `Prompted`, `Steered`, or `Queued follow-up for`, then the child. A steer goes in after the current tool round. A follow-up starts after the current answer.
- `wait` waits until the child answers its last message, up to `--timeout` seconds (default 1800), and prints `<handle> finished`, a blank line, and the answer. When the spawn or an earlier `send` has an answer that no `wait` gave, it prints `<n> unread answers, oldest first.`, a blank line, and each answer after a line `--- Answer <i> of <n> ---`, the last one last. An earlier turn that failed gives `(no answer: <error>)`. A steer shares the answer of the turn it went into, so that answer comes once. A failed or aborted last turn is an error: after an abort, it prints `<handle> was aborted`. The error gives the earlier unread answers in the same form, and does not give the failed turn twice. Each `wait` marks these answers read. A message sent while a `wait` runs stays unread for the next `wait`. Input from a mirror session is not counted.
- `stop` stops the work of the child and of the children it spawned, and removes them.
- `list` prints one line per child of the current caller: `<name> (<handle>)  <state>  <provider>/<model>  <thinking>`.
- `attach` opens the child in Pi in this terminal (see [Open in Pi](#open-in-pi)).

### Project agent

Each project has an agent, a conversation in its host that you talk to directly:

```sh
harness web
harness main
```

`harness <project>` opens the agent of the project in Pi in this terminal (see [Open in Pi](#open-in-pi)). It starts the host when none runs. A single word that is not `main`, a project or a command prints the usage. A `--project` before it is an error: `harness <project> takes no --project`.

- The agent works in the project directory, or in the home directory for `main`. Its system prompt, tools and bash env are the same as a child's in that directory (see [Host](#host)). Its bash commands get `PI_SESSION_ID`, the agent's conversation ID.
- When it is first opened, the agent gets Pi's default model (`defaultProvider` and `defaultModel` in Pi's `settings.json`) when it has a login, else the first model with a login, and Pi's `defaultThinkingLevel` (default `medium`), or the nearest level that the model has. Without a model with a login, Pi does not start and `harness <project>` prints `No model for the <project> agent: log in to a provider and set a default model in Pi (defaultProvider and defaultModel)`. A mirror session changes its model and thinking level as for a child.
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

A command goes to the project of `--project <name>`, which must come before the command (`harness --project carrefour list`), then of `HARNESS_PROJECT`, then of the current directory: the project with the longest directory that is the current directory or contains it. Without a match, the project is `main`, which has no directory. When two projects have the same directory, the first one created wins. An unknown project name is an error: `Unknown harness project: <name>`. The tool finds its project in the same way, from `HARNESS_PROJECT` and the current directory of their process.

The caller is `PI_SESSION_ID`, or `cli` when it is not set. `list` shows only the caller's children. The CLI and the tool refuse to `send` to, `rename`, or `stop` a child of another caller. A mirror session does not check the caller, because the host socket is for one user: it can show, send to, and abort the child of any caller. It sends text with an `input` request, stops a turn with an `abort` request, and changes the model or the thinking level with a `configure` request. None of these requests has a caller.

`openChildTab` of `@vzlentin/harness/herdr` opens a child in Pi in a new Herdr tab with the label `<name>` (or the handle), in the child's working directory. The tab runs `env <node> <cli> --project <project> attach <handle>`, where `<cli>` is `dist/cli.js` of the install, or `src/cli.ts` of a checkout: `harness attach` with this Node and this install's CLI, so it does not need `harness` on `PATH`, on the project of the caller. When `XDG_STATE_HOME` or `XDG_CONFIG_HOME` is set, the tab gets it too. When a `herdr` call fails, it rejects with the stderr of `herdr`, or with the reason that the call failed.

## Open in Pi

`harness attach <handle>` opens a child in Pi in the current terminal, and `harness <project>` opens the agent of the project. They start the host when none runs, and check the child before Pi starts: an unknown handle is an error, `Unknown subagent: <handle>`, and so is a project agent without a model. Then they run `pi --harness <project>` for the project agent, or `pi --harness <project> --harness-child <handle>` for a child, which opens a mirror session (see [Mirror sessions](#mirror-sessions)), and exit with the exit code of Pi. They run the `pi` of `PATH` without the `node_modules/.bin` folders, as setup does; without one, the error is `pi is not on PATH. Install Pi to open the agent`. That Pi needs the extension of the package (see [Pi extension](#pi-extension)). Closing Pi never changes the child.

In a Herdr pane (`HERDR_ENV` is set), Pi gets `HARNESS_HERDR_PANE` with the pane of `HERDR_PANE_ID`, in place of `HERDR_ENV`. Herdr's own Pi integration then does not report that pane, and the mirror session reports the state of the agent at each change: `herdr pane report-agent --source custom:harness --agent <label> --state working|idle --seq <n> <pane> -- <resume>`. The label is the name of the child, or its handle, and `<project> agent` for the project agent; it is the name at the first connection, and a rename does not change it. The resume command is the command that `openChildTab` runs, `env <node> <cli> --project <project> attach <handle>`, or `env <node> <cli> <project>` for the project agent. A busy agent is `working`; an idle agent, an agent with an error, and an agent without a connection are `idle`. `--seq` increases with each call. When Pi leaves the mirror session, it calls `herdr pane release-agent`. A failed `herdr` call does not stop Pi. A mirror session in a Pi that you start yourself in Herdr does not report, because Herdr's Pi integration holds that pane.

## Host

The children of a project run in one host process, `harness --project <name> host` (default `main`). The host takes its project only from `--project`, not from `HARNESS_PROJECT`. The first command that needs it starts it in the background. It exits after 5 minutes with no connection, no running work, and no command other than `list` and `status`. An open mirror session is a connection, and a live started task is running work, so each keeps the host running. A task that no loaded entry can run, such as one of an entry that was removed, is not running work, and neither is a task that waits only on such tasks. The host waits up to 60 s for the lock of `durable.sqlite`, so a client that reads the file, such as the workflows CLI, does not make it fail. The wait is synchronous: while it lasts, the host answers no request.

The host keeps its state in `$XDG_STATE_HOME/harness/<project>/` (default `~/.local/state/harness/<project>/`):

- `durable.sqlite`: the children's conversations and records, the started tasks, and the project agent, which is the store's root conversation. Work that a host stop interrupts continues when the host starts again. A host refuses a `durable.sqlite` from a version before the children library: stop the old host, remove the file and run the command again.
- `lock.sqlite`: one host at a time.
- `host.sock`: the socket the CLI and the extension connect to. The protocol has version 8. The `watch` reply is `{ view, child }`. Each event of a watch is `{ change, child }` after a commit to the conversation, `{ change: {}, child }` after a rename, or `{ stopped: true }`. A change gives the parts of the view that the commit changed, as whole values, so a client needs no chord: `entries` is `{ from, items }`, the entries from index `from` on; `docs` has each document that changed, by kind, and `null` for a document that was removed; `conversation` is the conversation record. After a watch that fell behind, the change is `{ view }`, the whole view. A `configure` request `{ handle, provider?, model?, thinking? }` replies with the child, and refuses an unknown model and a thinking level that the model does not have. After a `watch` reply, each event of the watch is a `{ "event": ... }` line, and every other line is a reply, in request order. A request line that is not valid fails with `Unknown or invalid request: <type>`, or `Invalid request` when it has no string `type`. A client rejects its waiting request with `The harness host sent an invalid reply: <line>` when a reply line from the host is not valid. A client refuses a host with another version. When the host is older, stop it with `kill <pid>` and run the command again. When the client is older, reload Pi with `/reload`, or use the CLI of the host's install. The `watch`, `input`, `abort` and `configure` requests take the handle `agent` for the project agent; its info is a child with the handle `agent` and the name `<project> agent`, and its watch never sends `stopped`. Other requests refuse it as an unknown subagent.
- `host.log`: the host's output.

The host loads two kinds of entries when it starts. First, the `piDurable` entries of the packages in Pi's settings, such as pi-ipython: a package lists its entry modules in its `package.json`, as `{ "piDurable": { "extensions": ["./durable/index.ts"] } }`. Second, the entries in `$XDG_CONFIG_HOME/harness/entries.json` (default `~/.config/harness/entries.json`), an object of entry name to the absolute path of a module, for packages that are not Pi packages, such as workflows. A package sets its entry there with `setEntry(name, module)` of `@vzlentin/harness/entries`, which is true when it changed the file. A host that runs already loads a new or changed entry only after it starts again. Missing packages are skipped, not installed, and so is an entry module that does not exist, such as one of an uninstalled package. A package whose `package.json` is not a JSON object, or has a `piDurable` field that is not valid, gives a warning and is skipped. Node does not strip types under `node_modules`, so the host loads a TypeScript entry there through jiti. It calls the default export of each entry with `{ durable, ai, events, children, place }`: the host's pi-durable and pi-ai modules, one event bus that all entries share, the children library, and the host's `place` (store, models and tools) for `children.open`. The entries load before the host opens its store, so `place.store` is usable only once the host is open, which means inside tasks. An entry returns `{ extensions, tasks?, close }`. The host installs `extensions` and `tasks`, and refuses to start when two entries give a task with the same name. An entry that returns no `tasks` loads as before.

A client starts and follows the tasks of the entries with four requests:

- `start { kind, input, key, version? }` creates a task of the kind `kind`, with the input `input`, and replies with its info `{ key, id, kind, version, status, outcome? }`. `version` is the version on the task's record: the version of the entry's task definition that last ran or migrated the task. It shows which version of the entry the host used for this task, not which version the host has loaded now. `outcome` is there only when the task is terminal. The key is the client's own name for the task. A repeated `start` with a known key gives the first task, and its new kind, version and input are ignored. An unknown kind gives `Unknown task kind: <kind>`. With `version`, a host whose definition of the kind has another version creates nothing and gives `This host has version <n> of <kind>, not <version>: stop the host so it starts again with the installed version`. Before it creates the task, `start` sets up the project agent, so a child that the task opens without a model takes the agent's; when the agent has no model, the task still starts.
- `task { key }` replies with the info of the task.
- `wait-task { key }` waits until the task is terminal, and replies with its info, with the outcome. To follow the status during the run, poll `task`.
- `abort-task { key }` aborts the task and the work that it owns, such as the turns of its children, and replies with the info.

The other requests refuse a key that no `start` gave with `Unknown task: <key>`. The host keeps each key and its task in `durable.sqlite`, and no request removes a key, so the key map only grows. A started task is a background task of the root conversation, so an abort of the project agent (Esc in its mirror session) does not reach it. A task that a host stop interrupts continues when the host starts again. The children that tasks open are not in `list`, and neither is a subagent that the library closed outside `stop`, such as one under a workflow session whose run ended.

A host from before the projects kept its state in `$XDG_STATE_HOME/harness/`. To keep its children, stop that host, then move `durable.sqlite` and its `-wal` and `-shm` files into `main/` before the `main` host starts.

A child's bash commands get `PI_SESSION_ID` (the child's conversation ID), `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, and `HARNESS_PROJECT`, so a child can spawn its own children with the same configuration, in the same project. A child of a child is the deepest level: a deeper spawn fails with `Nested subagents are disabled`. Children survive `/reload` and the end of the parent Pi session. `harness stop` removes a child and the children it spawned permanently.

A child's system prompt has what a Pi session in the child's working directory gets: the `AGENTS.md` or `CLAUDE.md` of the agent directory and of the working directory and its parents, the skills, and the working directory. User skills always load. Project skills (`.pi/skills`, and `.agents/skills` in the working directory and its parents) load only for a trusted project: a directory without project resources, then the decision saved with `/trust`, then the `defaultProjectTrust` setting, where `ask` counts as not trusted. A trust decision that a Pi session made for itself without saving it does not reach its children; when the tool spawns in such a session, it adds `The child gets no project skills (.pi/skills, .agents/skills): this project is trusted for this Pi session only, and children see only the trust saved for future sessions. To give children project skills, run /trust and choose Trust.` to its output. The host checks the trust on every model request, so a decision saved later applies from the next request. The host reads the instructions and skills of a directory once per trust decision and keeps them until it exits. It skips packages that are not installed. When the instructions or skills of a directory fail to load, the child gets none for that request, the host writes a warning, and the next request tries again.

## Limits

- Children get only `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `subagent`, and the tools of the host's entries (see [Host](#host)). They get no MCP tools and no Pi extensions.
- A change to `AGENTS.md` or to a skill reaches children only after the host restarts.
- `--file` gives text only; images are not attached.
- The CLI sends each `spawn` once and has no `key`. If the host stops during a `spawn` and you run the command again, there can be two children.

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

- In Pi, the extension in the `pi/` folder of the package gives the tool (see [Pi extension](#pi-extension)). The caller is the session ID, the same as `PI_SESSION_ID` for the CLI, so `harness list` in that session shows the tool's children.
- In another pi-durable host, the entry `@vzlentin/harness/durable-entry` gives the tool. The caller is `<store>:<conversation ID>`, where `<store>` is a random ID that the store keeps. A call that runs again after the host restarts uses the same key, so its spawn or send does not repeat.

The children get the tool too. Their caller is their conversation ID, as for their bash commands.

## Pi extension

The package has the Pi extension in its `pi/` folder: the `subagent` tool, the `/subagent` command, the subagents widget and the mirror sessions (see [Mirror sessions](#mirror-sessions)). `/subagent` lists the children of the session and opens the one that you select in Pi, in a new Herdr tab (see `openChildTab`); outside Herdr, it shows `Run in another terminal: harness attach <handle>`. It uses the `dist/` modules of the same package, so it starts the host of that install. Pi records the path of the folder and loads it from there; it does not copy it.

### Mirror sessions

A mirror session is a Pi session that shows a child or the agent of a project (see [Project agent](#project-agent)) in Pi's own chat, and sends what you type to it. The agent runs in the host of the project, so it continues when Pi closes. Below, the agent is the child or the project agent that the session shows. The mirror sessions work only in Pi's interactive mode.

- `/harness <project>` opens a new Pi session that mirrors the agent of `<project>`, which is `main` or a project name. An unknown project is an error: `harness: Unknown harness project: <name>`. The command completes the project names. Without a project, it asks for one in the list `Harness project`, with one line `<name>  <dir>` for each project: the project of Pi's working directory first (as for a command), then the other projects, then `main` with `~`. When `main` is the only project, it opens `main` and does not ask. Esc cancels.
- `pi --harness <project>` mirrors the agent of the project in the session that Pi starts with, and `pi --harness <project> --harness-child <handle>` mirrors a child of the project (see [Open in Pi](#open-in-pi)). Without `--harness`, or with an empty project, the project is the one of `HARNESS_PROJECT` and Pi's working directory. It refuses a session with messages, such as one of `--continue`: `harness: --harness needs a new session, not one with messages`.
- The session has the title of the agent as its name, `<name> (<handle>)` or `<project> agent`, and follows a rename. It holds one custom entry, `harness-mirror`, with the target `{ project, handle }`, and Pi draws the conversation of the agent in place of that entry, with Pi's message and tool components and Pi's theme (adapted from the attach view of [mavam/pi-agents](https://github.com/mavam/pi-agents)): the user messages, the answers with their thinking, and a Pi tool card for each call of `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`, with its output while it runs. Other tools get Pi's generic card. A compaction shows `[compaction]` and its summary, and a reset shows `[new context]`. The first line is `harness │ <title> │ <working directory>`. Pi saves a session only when it has a message, so it does not save a mirror session and `/resume` does not list it; run `/harness` again to open it.
- A message that you send goes to the agent: a new turn when it is idle, a steer when it works. Pi's own agent does not run. While the agent works, Esc aborts its turn, and the queued messages go back to the editor, steers first; Alt+Enter (`app.message.followUp`) queues the text as a follow-up. The extension uses its own editor in the session for these keys.
- Above the editor, Pi's working indicator shows what the agent does (`Working...`, `Running <tool>...`, `Compacting (<reason>)...` or `Retrying (attempt <n>): <error>`), and each queued message shows as `Steer: <first line>` or `Follow-up: <first line>`.
- The answers of the agent follow Pi's `hideThinkingBlock` setting: Ctrl+T (`app.thinking.toggle`) hides and shows their thinking, as for Pi's own messages.
- The last line above the editor is `<title> • <usage> • <context>`, without the parts that are empty. The usage has the sums of the agent's model requests and tool results, as Pi's footer shows its own: `↑` input, `↓` output, `R` cache read, `W` cache write and `$` cost, each when it is not zero, and the cost also when Pi uses a subscription for the model, with `(sub)`. The context is `<percent>%/<window>`: the context of the agent's last answer that did not abort or fail, against the context window of its model, when Pi knows the model. Pi's footer stays as it is, for the local Pi session: Pi's own footer, or the footer of an extension.
- Pi's model and thinking level follow the agent's. A model that you select in Pi (`/model`, Ctrl+P) and a thinking level (Shift+Tab) go to the agent with a `configure` request. A refused change gives an error, and Pi goes back to the agent's model.
- When the host closes the connection, the session connects again, which starts a new host when none runs. It shows `Connecting again to the harness host...` above the editor. It tries three times: at once, after 2 s, and after 5 s. When all tries fail, the session shows `The harness host closed the connection. Connecting again failed: <error>`. When the host closes a connection that was opened again less than 10 s before, the session does not connect again and shows `The harness host closed the connection. Run /reload to attach again`. When the child is stopped, the session shows `<name> (<handle>) was stopped`. `/reload` attaches again, and starts the host when none runs. `/new` and `/resume` leave the mirror session; the agent keeps running.
- A message that you send while the session connects waits for the connection. When the connection closes before the host answers a message, the message goes again on the next connection with the same request ID, so the agent gets it once. A message that does not reach the agent, because the host refuses it or the session fails first, goes back to the editor, after the text there, and Pi shows `harness: not sent: <reason>`.
- Images are not sent: the agent gets only the text, with the warning `harness: the images are not sent; the agent gets only the text`. Pi does not expand skill commands and prompt templates for the agent. Pi's own session commands act on the local Pi session, which has no messages: `/compact` fails with `Nothing to compact (session too small)`, `/fork` gives `No messages to fork from`, `/tree` shows `No entries found`, and `/export` fails with `Nothing to export yet - start a conversation first`.

Setup registers the extension in Pi. It acts only for a top-level global install: the real path of the package is `<root>/@vzlentin/harness`, where `<root>` is a `node_modules` folder in `lib` (the prefix on Windows) with no other `node_modules` folder above it. A copy that npm puts in another global package, a dependency of a project and a checkout get no setup. Setup does this, with its output on stderr:

1. When the `packages` of Pi's global settings (`$PI_CODING_AGENT_DIR/settings.json`, default `~/.pi/agent/settings.json`) do not list `<package>/pi` as a local path, it runs `pi install <package>/pi`. Pi writes the entry relative to the agent directory. An entry that resolves to the folder, absolute or relative to the agent directory, with `~` or as a `file:` URL, counts as listed, and setup runs no `pi`, so it does not change the settings.
2. Unless `pi` failed, it writes the stamp `$XDG_STATE_HOME/harness/.setup/<hash>` (default `~/.local/state/harness/.setup/`), where `<hash>` is the SHA-256 of the real path and the version of the package.

Setup runs `pi` from `PATH`, without the `node_modules/.bin` folders that npm adds, so the `pi` of the package's own dependencies is not used. When `pi` is not on `PATH`, it writes `harness: pi is not on PATH. To add the Pi extension of harness, run: pi install <path>`. When `pi` fails, it writes `harness: pi install failed (<reason>). ...` with the same command. A Pi failure does not fail setup, but it writes no stamp, so the next `harness` command tries again. When `pi` is not on `PATH`, the stamp is written, so a user without Pi gets the hint once per version; after installing Pi, run the `pi install` command of the hint.

Two things run setup:

- The `postinstall` script, when npm sets `npm_config_global=true` (`npm install -g`). It runs setup every time, so a reinstall repairs the entry. npm 11 runs it; npm 12 does not run install scripts by default. npm shows its output only with `--foreground-scripts`. An error in it is a warning, and the npm install succeeds. Another install, such as `npm ci` in a checkout, does nothing.
- The installed CLI (`dist/cli.js`), before each command but `host`, when the stamp of this path and version does not exist. So with npm 12, the first `harness` command after an install or an update does the setup. Setup never fails the command: an error writes `harness: setup failed: <reason>`. The checkout's `src/cli.ts` runs no setup.

`@vzlentin/harness/setup` exports the two functions, for another package with a `pi/` folder, such as workflows. Each takes the directory of the package, reads its `name` and `version` from its `package.json`, and uses the last part of the name in its messages:

- `setup(packageDir)`: setup as above. It throws when it cannot read the `package.json` or write the stamp, not for a Pi failure.
- `setupOnce(packageDir)`: setup when the stamp of this path and version does not exist. It never throws: an error writes `harness: setup failed: <reason>`.

npm runs no script on `npm uninstall`, so the entry stays in Pi until `pi remove <path>`; Pi starts without the extension when the path is gone.
