"""The `rlm` client of an IPython kernel of the harness host, with the actions of the `subagent` tool.

The host binds `rlm = Rlm()` in the kernel. Each call opens its own connection to the kernel's server, so
`asyncio.gather` runs several calls at the same time. A cancelled call closes its connection, which stops its request
in the host; the child continues. Standard library only, for Python 3.9 or later.
"""

import asyncio
import json
import os

__all__ = ["Rlm", "RlmError"]


class RlmError(RuntimeError):
    """A refused or failed call, with the error text of the host."""


def _handle(handle):
    """The handle text of `handle`: the text itself, or the `handle` of a child dict that a call gave."""
    return handle["handle"] if isinstance(handle, dict) else handle


async def _call(action, args):
    """Sends `action` with `args`, the other arguments of the `subagent` tool without those that are None, and gives
    the value of the reply."""
    socket = os.environ.get("HARNESS_RLM_SOCKET")
    token = os.environ.get("HARNESS_RLM_TOKEN")

    if not socket or not token:
        raise RlmError("This kernel has no harness host: HARNESS_RLM_SOCKET and HARNESS_RLM_TOKEN are not set")

    request = {"token": token, "action": action, "args": {k: v for k, v in args.items() if v is not None}}

    try:
        reader, writer = await asyncio.open_unix_connection(socket)
    except OSError as error:
        raise RlmError(f"Could not reach the harness host: {error}") from error

    try:
        # UTF-8, not ASCII escapes, as the limits of the host count bytes. A lone surrogate goes as its JSON escape.
        writer.write(json.dumps(request, ensure_ascii=False).encode("utf-8", "backslashreplace") + b"\n")
        await writer.drain()
        # The host sends one line and ends the connection, so the reply is everything up to the end.
        data = await reader.read()
    except OSError as error:
        raise RlmError(f"The connection to the harness host failed: {error}") from error
    finally:
        writer.close()

    if not data:
        raise RlmError("The harness host ended the connection without a reply")

    reply = json.loads(data)

    if not reply.get("ok"):
        raise RlmError(reply.get("error", "The harness host refused the call"))

    return reply["value"]


class Rlm:
    """The subagents of the kernel's conversation. Each method is a coroutine."""

    async def spawn(self, prompt, *, context=None, name=None, files=None, model=None, thinking=None, cwd=None):
        """Starts a child with `prompt`, then `context` in a `<context>` block, and gives the child as a dict.

        `model` is a model ID of the caller's provider, or `<provider>/<model>`, split at its first `/`.
        """
        prompts = [prompt]

        if context is not None:
            if not isinstance(context, str):
                raise RlmError("context must be text")

            prompts.append("<context>\n" + context + "\n</context>")

        provider = None

        if isinstance(model, str) and "/" in model:
            provider, _, model = model.partition("/")

        args = {
            "prompts": prompts,
            "name": name,
            "files": files,
            "provider": provider,
            "model": model,
            "thinking": thinking,
            "cwd": cwd,
        }

        return await _call("spawn", args)

    async def send(self, handle, message, *, follow_up=False):
        """Sends `message` to the child, and gives `{"verb", "child"}`."""
        return await _call("send", {"handle": _handle(handle), "message": message, "followUp": follow_up})

    async def wait(self, handle, timeout=1800):
        """Waits until the child answers its last message, and gives the answers that no earlier `wait` gave."""
        return (await _call("wait", {"handle": _handle(handle), "timeout": timeout}))["answer"]

    async def status(self, handle):
        """Gives the child."""
        return await _call("status", {"handle": _handle(handle)})

    async def rename(self, handle, name):
        """Renames the child, and gives it."""
        return await _call("rename", {"handle": _handle(handle), "name": name})

    async def list(self):
        """Gives the children of the conversation."""
        return await _call("list", {})

    async def stop(self, handle):
        """Stops the child and the children it spawned, and gives `{"handle", "name"}`."""
        return await _call("stop", {"handle": _handle(handle)})
