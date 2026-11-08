/** The text of the `<rlm>` section, for a conversation whose IPython kernel has `rlm`. */
export const RLM_SECTION = `The IPython kernel has \`rlm\`, a client for your subagents. Each method is a coroutine: call it with \`await\`.
- \`await rlm.spawn(prompt, *, context=None, name=None, files=None, model=None, thinking=None, cwd=None)\` starts a child and gives it as a dict: \`handle\`, \`name\`, \`state\`, \`provider\`, \`model\`, \`thinking\`, \`cwd\`. The child gets \`context\` after the task, in a \`<context>\` block. \`model\` is a model of your provider, or \`<provider>/<model>\`. Without \`model\`, \`thinking\` or \`cwd\`, the child uses yours. A relative \`cwd\` or file path is relative to your working directory.
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

The children are your subagents: the same children as those of the \`subagent\` tool. Their answers come only with \`wait\`, never as a message. They stay after the cell, also after a failed cell: \`await rlm.list()\` shows them. Stop each child when you no longer need it. Give your own answer as plain text in your reply.`;
