"""Change PowerFactory settings temporarily and always put them back.

    with StateGuard() as guard:
        guard.set(ldf, "iopt_net", 2, "ComLdf.iopt_net")
        ...

Every change is recorded before it is written. Leaving the block restores all of them in reverse order
and checks each one by reading it back. A setting that already has its original value is not written
again. If something could not be restored, StateRestoreError names each setting with the value that was
expected and the one found, together with the failure that ended the block, so one never hides the other.

Standard library plus the engine helpers only.
"""

import gridlens_engine as engine


class StateRestoreError(RuntimeError):
    """Settings changed by this script could not be put back; the Study Case needs a manual check."""


def _same(current, original):
    left, right = engine.finite_number(current), engine.finite_number(original)
    return left == right if left is not None and right is not None else current == original


def _found(obj, attribute):
    """What PowerFactory reports for the setting, for the error message."""
    try:
        return repr(getattr(obj, attribute))
    except Exception as exc:
        return "unreadable (" + str(exc) + ")"


class StateGuard:
    def __init__(self):
        self._changes = []

    def set(self, obj, attribute, value, label):
        """Write `value`; False if it could not be written and read back. The old value is kept for restore()."""
        known, original = engine._read_setting(obj, attribute)
        if not known or engine.finite_number(original) is None:
            return False
        self._changes.append((obj, attribute, original, label))
        return engine._set_scalar_attribute(obj, attribute, value)

    def restore(self):
        """Put everything back; returns one message per setting that could not be restored."""
        errors = []
        for obj, attribute, original, label in reversed(self._changes):
            known, current = engine._read_setting(obj, attribute)
            if known and _same(current, original):
                continue
            if not engine._set_scalar_attribute(obj, attribute, original):
                errors.append("{}: expected {!r}, read back {}".format(label, original, _found(obj, attribute)))
        self._changes = []
        return errors

    def __enter__(self):
        return self

    def __exit__(self, kind, failure, _traceback):
        errors = self.restore()
        if errors:
            message = "PowerFactory state restoration failed. Verify the Study Case manually: " + "; ".join(errors)
            if failure is not None:
                message += ". The calculation had stopped before with: " + (str(failure) or type(failure).__name__)
            raise StateRestoreError(message) from failure
        return False
