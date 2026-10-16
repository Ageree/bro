"""Machine checks of the f-* file suite: one registry over every check kind of docs/benchmarks/files/cases.json.

A kind is a function registered with @check. Per-file kinds (`group` set) get one received file at a time and the
selection rules of select.py; the others (`group=None`) look at the whole run. A kind that is not registered reports
`manual`, never a pass. Heavy libraries are imported inside the functions, so importing this package is cheap
(build_cases.py --check imports it for the registry).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, NamedTuple

GROUPS = ("pdf", "xlsx", "docx", "pptx", "image", "zip", "ics", "vcf", "any")


class Outcome(NamedTuple):
    status: str  # pass | fail | error | manual
    detail: str = ""


def passed(detail: str = "") -> Outcome:
    return Outcome("pass", detail)


def failed(detail: str) -> Outcome:
    return Outcome("fail", detail)


def errored(detail: str) -> Outcome:
    return Outcome("error", detail)


class CheckError(Exception):
    """The check could not be evaluated (bad params, unreadable file): reported as `error`, never as a pass or a fail."""


@dataclass(frozen=True)
class Spec:
    kind: str
    fn: Callable
    group: str | None  # None: not per file
    negative: bool
    quantifier: str  # any | all


REGISTRY: dict[str, Spec] = {}

# Kinds the suite uses that stay with the reviewer; build_cases.py --check accepts them, check.py reports `manual`.
MANUAL_KINDS: dict[str, str] = {}


def check(kind: str, group: str | None = None, *, negative: bool = False, quantifier: str = "any"):
    if group is not None and group not in GROUPS:
        raise ValueError(f"unknown group {group}")

    def register(fn):
        if kind in REGISTRY:
            raise ValueError(f"{kind} is registered twice")
        REGISTRY[kind] = Spec(kind, fn, group, negative, quantifier)
        return fn

    return register


# Registration happens on import.
from . import behavior, image, misc, office, pdf, signed  # noqa: E402,F401
