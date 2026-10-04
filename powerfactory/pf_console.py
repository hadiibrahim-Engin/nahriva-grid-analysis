"""Messages to the PowerFactory output window that never raise.

PowerFactory may already have torn the application object down when a script fails ("already deleted").
A message about an error must not replace that error, so a failing PrintPlain falls back to stderr.

    log(app, "message")               [Outage Assessment] message
    log(app, "message", "WARN")       [Outage Assessment][WARN] message
    step(app, 2, 5, "Reference")      a visible section header
    detail(app, "message")            an indented line that belongs to the current step
"""

import sys

PREFIX = "[Outage Assessment]"
RULE = "-" * 72


def log(app, message, level=""):
    line = PREFIX + ("[" + level + "] " if level else " ") + message
    try:
        app.PrintPlain(line)
    except Exception:
        try:
            print(line, file=sys.stderr)
        except Exception:
            pass


def step(app, number, total, title):
    log(app, RULE)
    log(app, "Step {}/{}: {}".format(number, total, title))


def detail(app, message, level=""):
    log(app, "    " + message, level)
