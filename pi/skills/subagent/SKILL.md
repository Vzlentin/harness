---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` tool to delegate work to a separate agent with its own context. Each subagent is a conversation in one background host process, which starts when needed. A subagent can spawn its own subagents, down to the depth limit: the `agentDepthLimit` setting in Pi's global `settings.json` (default 4), or 2 in a tree that a library such as workflows starts without a limit. A deeper spawn fails with `Nested subagents are disabled`.

When the tool is not available, use the `harness` CLI in bash. It has the same commands (see [CLI](#cli)).

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```json
{ "action": "spawn", "name": "implementation", "prompts": ["Complete task"] }
```

By default, the child uses your provider, model, and thinking level. Set `provider`, `model`, or `thinking` only when you deliberately choose a different configuration, for example a faster model for simple investigation or a stronger model for difficult review.

`cwd` defaults to your working directory. Give the task in `prompts` and the files to read in `files`; the child receives the text of the files and all prompts in its first message.

## Tools

Without `tools`, a child gets `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `subagent`, `codemode`, and the tools of installed packages that declare `piDurable` entries. `bash` can modify files, so it is not a read-only capability.

A child gets the `AGENTS.md` or `CLAUDE.md` files and the user skills, as a Pi session in its working directory does. It gets the project skills only when the project is trusted. It gets no MCP tools and no other Pi extensions, so put what it needs from them in the prompt.

`tools` is an allowlist. An unknown name is an error. Common choices:

- `["read", "grep", "find", "ls"]`: enforced read-only repository investigation.
- `["read", "grep", "find", "ls", "bash"]`: investigation that may run tests or other commands; bash can modify files.
- Omit `tools` for implementation work.

Spawn prints `Spawned <name> (<handle>)`. The handle is the short hex ID in parentheses, not the name. Keep the handle for later actions. Subagents persist after their current turn completes: `wait`, completion, and becoming idle do not terminate them. They survive `/reload` and the end of the spawning Pi session. They are only removed by `stop`.

## Answers and wait

When a child finishes, its answer comes to you as a message that starts a turn. Use `wait` only when you need the answer in this turn. `notify: false` on `spawn` or `send` turns off this message; then get the answers with `wait`.

```json
{ "action": "status", "handle": "<handle>" }
{ "action": "list" }
{ "action": "wait", "handle": "<handle>" }
```

Use `list` at any time to find the subagents of this session again, with their handles, names, and current states.

`wait` waits until the subagent answers its last message, up to `timeout` seconds (default 1800), and gives its answer. If an earlier answer of the spawn or a `send` was never given by a `wait`, it gives those answers first, oldest first, each under a `--- Answer <i> of <n> ---` line. It fails when the last turn failed, and the error still includes the earlier answers. When a message already gave the answer, `wait` gives `No new answers: the last answer came as a message.` `subagent` tool calls in one message run in message order, so a `wait` after a `send` in the same message waits for the answer to that message.

## Communicate

```json
{ "action": "rename", "handle": "<handle>", "name": "new name" }
{ "action": "send", "handle": "<handle>", "message": "message" }
{ "action": "send", "handle": "<handle>", "message": "message", "followUp": true }
```

`rename` changes the name shown in the parent UI. Names are 1 to 64 characters and need not be unique. `send` to an idle child starts a new prompt; to a busy child it steers the current work after its current tool round. With `followUp`, it waits until the current work finishes, then starts another turn.

## Stop

```json
{ "action": "stop", "handle": "<handle>" }
```

Stop every subagent when you no longer need it; do not leave completed subagents idle. This stops its work and the work of its own children, and removes it. Keep an idle subagent only when you expect concrete follow-up work, then stop it afterward.

For humans, not for you: the interactive `/subagent` command opens a child in Pi in a new Herdr tab. Outside Herdr, it shows the `harness attach <handle>` command, which opens a mirror session of the child, where the user can read and send messages.

## CLI

```sh
harness spawn --name implementation --prompt "Complete task"
harness spawn --tools read,grep,find,ls,bash --file docs/spec.md --prompt "Investigate the failure"
harness status <handle>
harness list
harness wait <handle>
harness rename <handle> "new name"
harness send <handle> "message"
harness send <handle> --follow-up "message"
harness stop <handle>
```

The CLI takes the provider, model, and reasoning level from the bash environment. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to it explicitly. Repeat `--prompt` and `--file` as needed; `--tools` is a comma-separated list. Run `harness spawn` and `harness wait` directly, without piping or redirecting their output, so the bash tool returns it. Set the bash timeout above the default 1800-second deadline of `wait`.
