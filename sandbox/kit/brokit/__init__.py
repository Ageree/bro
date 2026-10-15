"""brokit: the task agent's file kit (sandbox/kit/README.md)."""

import os


def kit_version():
    """The kit's content hash from the VERSION file the delivery writes beside the package ("dev" in a checkout)."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "VERSION")
    try:
        with open(path, encoding="ascii") as handle:
            return handle.read().strip()[:16] or "dev"
    except (OSError, UnicodeDecodeError):
        return "dev"


def producer():
    """/Producer of the PDFs the kit writes (W2 spec §5.0)."""
    return "brokit " + kit_version()
