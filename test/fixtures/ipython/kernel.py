"""A kernel for the tests. Each JSON line on stdin is a cell, which runs in one namespace on one asyncio loop, with
top-level `await`. Each cell gives one JSON line on stdout: its printed output, and for an exception, the last line of
its traceback with `error`."""

import ast
import asyncio
import contextlib
import io
import json
import sys
import traceback

NAMESPACE = {"__name__": "__main__"}
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
REPLIES = sys.stdout


def run(code):
    printed = io.StringIO()

    try:
        with contextlib.redirect_stdout(printed):
            result = eval(compile(code, "<cell>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), NAMESPACE)

            if asyncio.iscoroutine(result):
                LOOP.run_until_complete(result)
    except BaseException:
        return {"output": printed.getvalue() + traceback.format_exc().strip().splitlines()[-1], "error": True}

    return {"output": printed.getvalue(), "error": False}


for line in sys.stdin:
    REPLIES.write(json.dumps(run(json.loads(line)["code"])) + "\n")
    REPLIES.flush()
