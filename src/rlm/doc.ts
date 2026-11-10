import { CUT_LINE, MAX_ANSWER, MAX_INPUT, MAX_LIVE_CHILDREN, POOL_SIZE, TURN_DEADLINE_MS } from "./limits.ts";

/** The docstring of `rlm`, which the startup code of a kernel sets: the API of the client and the limits. */
export const RLM_DOC = `The IPython kernel has \`rlm\`, a client for your subagents. Each method is a coroutine: call it with \`await\`.
- \`await rlm.spawn(prompt, *, context=None, name=None, files=None, model=None, thinking=None, cwd=None)\` starts a child and gives it as a dict: \`handle\`, \`name\`, \`state\`, \`provider\`, \`model\`, \`thinking\`, \`cwd\`, \`kind\` (\`"rlm"\`). The child gets \`context\` after the task, in a \`<context>\` block. \`model\` is a model of your provider, or \`<provider>/<model>\`. Without \`model\`, \`thinking\` or \`cwd\`, the child uses yours. A relative \`cwd\` or file path is relative to your working directory.
- \`await rlm.send(handle, message, *, follow_up=False)\` sends \`message\` to the child, and gives \`{"verb", "child"}\`.
- \`await rlm.wait(handle, timeout=1800)\` waits until the child answers its last message, and gives the answers that no earlier \`wait\` gave, as text.
- \`await rlm.status(handle)\` and \`await rlm.rename(handle, name)\` give the child.
- \`await rlm.list()\` gives your children.
- \`await rlm.stop(handle)\` stops the child and the children it spawned, and gives \`{"handle", "name"}\`.
A \`handle\` is the handle text or a child dict that a call gave. A refused or failed call raises \`RlmError\`, a \`RuntimeError\` (\`from harness_rlm import RlmError\`).

Fan out with \`asyncio.gather\`:
\`\`\`python
import asyncio
children = [await rlm.spawn(f"Summarize part {i}", context=part) for i, part in enumerate(parts)]
answers = await asyncio.gather(*(rlm.wait(child) for child in children))
\`\`\`

The children are your subagents: the same children as those of the \`subagent\` tool. Their answers come only with \`wait\`, never as a message. They stay after the cell, also after a failed cell: \`await rlm.list()\` shows them. Stop each child when you no longer need it. Give your own answer as plain text in your reply.

The limits of these children:
- You can have ${MAX_LIVE_CHILDREN} children that are not stopped. A ${MAX_LIVE_CHILDREN + 1}th spawn raises \`RlmError\`: stop a child before you spawn another.
- The prompt of a spawn, with its files and context, and the message of a send, can have at most ${MAX_INPUT.text} of UTF-8. A larger one raises \`RlmError\`: split the work.
- The host aborts a turn of a child after ${TURN_DEADLINE_MS / 60_000} minutes. \`wait\` then raises \`RlmError\` with \`<handle> was aborted\`. The child stays: you can send it a smaller task.
- \`wait\` cuts each answer of a child at ${MAX_ANSWER.text}, and adds the line \`${CUT_LINE}\`. Ask for short answers.
- Your tree of children runs at most ${POOL_SIZE} model requests at the same time. The other children wait for their turn, the shallowest first.`;
