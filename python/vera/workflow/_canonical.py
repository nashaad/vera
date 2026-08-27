from __future__ import annotations

import hashlib
import json
import math

from ._errors import WorkflowError


def _validate(value: object) -> None:
    value_type = type(value)
    if value is None or value_type in (str, int, bool):
        return
    if value_type is float:
        if math.isfinite(value):
            return
        raise WorkflowError("serialize", "non-finite floats are not JSON values")
    if value_type is list:
        for item in value:
            _validate(item)
        return
    if value_type is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise WorkflowError("serialize", "JSON object keys must be strings")
            _validate(item)
        return
    raise WorkflowError(
        "serialize",
        f"{value_type.__name__} is not a supported JSON value",
    )


def dumps(value: object) -> str:
    try:
        _validate(value)
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
    except RecursionError as error:
        raise WorkflowError("serialize", "cyclic values cannot be serialized") from error


def digest(args: tuple[object, ...], kwargs: dict[str, object]) -> str:
    canonical = dumps({"args": list(args), "kwargs": kwargs}).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()[:8]
