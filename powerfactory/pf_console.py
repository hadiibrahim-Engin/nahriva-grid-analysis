"""Messages to the PowerFactory output window that never raise.

PowerFactory may already have torn the application object down when a script fails ("already deleted").
A message about an error must not replace that error, so a failing PrintPlain falls back to stderr.
"""

import sys

PREFIX = "[Outage Assessment]"


def log(app, message, level=""):
    line = PREFIX + ("[" + level + "] " if level else " ") + message
    try:
        app.PrintPlain(line)
    except Exception:
        print(line, file=sys.stderr)
