"""Messages to the PowerFactory output window that never raise.

PowerFactory may already have torn the application object down when a script fails ("already deleted").
A message about an error must not replace that error, so a failing PrintPlain falls back to stderr.

The output is structured in three levels so that a long run stays readable:

    ====================================  section: a step of the assessment, the summary, an error
     STEP 2/5 · Reference (REF)
    ====================================
    ------------------------------------  subsection: one scenario
     Scenario 3/20 · NE_L1
    ------------------------------------
    .. Case OUTAGE · NE_L1 ............  case: one QDS run (REF / OUTAGE), a single dotted line
        indented lines                     details that belong to the current block

    log(app, "message")               [Outage Assessment] message
    log(app, "message", "WARN")       [Outage Assessment][WARN] message
    detail(app, "message")            an indented line that belongs to the current block
    table(app, header, rows)          aligned columns, indented like a detail
"""

import sys

# Raise when the way this module is called by the others changes (arguments, return values). start_assessment.py
# compares it across all modules, so files of different versions are named instead of failing in a confusing way.
INTERFACE_VERSION = 5

PREFIX = "[Outage Assessment]"
WIDTH = 78
HEAVY = "=" * WIDTH
LIGHT = "-" * WIDTH


def _emit(app, line):
    try:
        app.PrintPlain(line)
    except Exception:
        try:
            print(line, file=sys.stderr)
        except Exception:
            pass


def log(app, message, level=""):
    _emit(app, PREFIX + ("[" + level + "] " if level else " ") + message)


def detail(app, message, level=""):
    log(app, "    " + message, level)


def section(app, title):
    """A heavy-ruled header with a blank line before it."""
    _emit(app, "")
    log(app, HEAVY)
    log(app, " " + title)
    log(app, HEAVY)


def subsection(app, title):
    """A light-ruled header with a blank line before it."""
    _emit(app, "")
    log(app, LIGHT)
    log(app, " " + title)
    log(app, LIGHT)


def case(app, title):
    """A single dotted line that starts one calculation case inside a step or a scenario."""
    head = ".. " + title + " "
    log(app, head + "." * max(3, WIDTH - len(head)))


def step(app, number, total, title):
    section(app, "STEP {}/{} · {}".format(number, total, title))


def table(app, header, rows, level=""):
    """Rows of strings in aligned columns (the last column is not padded); `header` may be None."""
    lines = ([tuple(header)] if header else []) + [tuple(str(cell) for cell in row) for row in rows]
    if not lines:
        return
    widths = [max(len(line[i]) for line in lines) for i in range(len(lines[0]))]
    for number, line in enumerate(lines):
        text = "  ".join(cell.ljust(widths[i]) if i < len(line) - 1 else cell for i, cell in enumerate(line))
        detail(app, text, level)
        if header and number == 0:
            detail(app, "  ".join("-" * widths[i] if i < len(line) - 1 else "-" * min(widths[i], 40) for i in range(len(line))))
