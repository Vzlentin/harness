"""The `tools` of an IPython kernel of the harness host or of Pi: the tools of the conversation of the running cell.

The startup code of the kernel binds `tools = Tools()`. `await tools.<name>(**args)` runs the tool `<name>` while a
cell runs, with the arguments as the cell gives them. The kernel's server checks them against the schema of the tool.
Each call opens its own connection to the server, so `asyncio.gather` runs several calls at the same time. The text of
`tools.__doc__` and `tools.<name>.__doc__` comes from the server, so this module has no copy of a tool schema.
Standard library only, for Python 3.9 or later.
"""

import asyncio
import json
import os
import socket

__all__ = ["Tool", "ToolError", "Tools"]


class ToolError(RuntimeError):
    """A refused or failed call, with the error text of the tool or of the server."""


def _address():
    """The socket and the token of the kernel's server, from the environment of the kernel."""
    path = os.environ.get("HARNESS_TOOLS_SOCKET")
    token = os.environ.get("HARNESS_TOOLS_TOKEN")

    if not path or not token:
        raise ToolError("This kernel has no harness bridge: HARNESS_TOOLS_SOCKET and HARNESS_TOOLS_TOKEN are not set")

    return path, token


def _line(request, token):
    """The request line: UTF-8, not ASCII escapes, as the line bound of the server counts bytes. A lone surrogate goes
    as its JSON escape."""
    return json.dumps(dict(request, token=token), ensure_ascii=False).encode("utf-8", "backslashreplace") + b"\n"


def _value(data):
    """The value of the reply `data`, or the error of the server as a `ToolError`."""
    if not data:
        raise ToolError("The harness bridge ended the connection without a reply")

    reply = json.loads(data)

    if not reply.get("ok"):
        raise ToolError(reply.get("error", "The harness bridge refused the call"))

    return reply.get("value")


async def _request(request):
    """Sends `request` on a new connection, and gives the value of the reply."""
    path, token = _address()

    try:
        reader, writer = await asyncio.open_unix_connection(path)
    except OSError as error:
        raise ToolError(f"Could not reach the harness bridge: {error}") from error

    try:
        writer.write(_line(request, token))
        await writer.drain()
        # The server sends one line and ends the connection, so the reply is everything up to the end.
        data = await reader.read()
    except OSError as error:
        raise ToolError(f"The connection to the harness bridge failed: {error}") from error
    finally:
        writer.close()

    return _value(data)


def _tools():
    """The tools that the running cell can call, as `{name, description, parameters}`. It blocks: a docstring cannot
    await."""
    path, token = _address()

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(path)
            connection.sendall(_line({}, token))
            chunks = []

            while chunk := connection.recv(65536):
                chunks.append(chunk)
    except OSError as error:
        raise ToolError(f"The connection to the harness bridge failed: {error}") from error

    return _value(b"".join(chunks))


class Tool:
    def __init__(self, name):
        self._name = name

    async def __call__(self, **args):
        """Runs the tool with `args`, and gives its structured output, else its text."""
        return await _request({"name": self._name, "args": args})

    @property
    def __doc__(self):
        """The description of the tool, and the JSON Schema of its arguments."""
        for tool in _tools():
            if tool["name"] == self._name:
                return f"{tool['description']}\n\nArguments, as JSON Schema:\n{json.dumps(tool['parameters'], indent=2)}"

        return f"No tool {self._name} in this cell"

    def __repr__(self):
        return f"<tool {self._name}>"


class Tools:
    def __getattr__(self, name):
        # IPython looks up names such as `_repr_html_` on each value it shows: they are not tools.
        if name.startswith("_"):
            raise AttributeError(name)

        return Tool(name)

    @property
    def __doc__(self):
        """The use of `tools`, and the tools of the cell with the first line of their description."""
        lines = [
            "The tools of the conversation of this cell. Each call is a coroutine:",
            "`await tools.<name>(**args)` runs a tool with the arguments of its schema, and gives its structured"
            " output, else its text. A refused or failed call raises `ToolError`, a `RuntimeError`"
            " (`from harness_tools import ToolError`). A call runs only while its cell runs. Use `asyncio.gather`"
            " to run several calls at the same time.",
            "`print(tools.<name>.__doc__)` gives the description of a tool and the JSON Schema of its arguments.",
            "",
        ]

        for tool in _tools():
            lines.append(f"- {tool['name']}: {tool['description'].splitlines()[0] if tool['description'] else ''}")

        return "\n".join(lines)

    def __repr__(self):
        return "<tools of the cell; print(tools.__doc__) lists them>"
