"""Python functions an agent's model may call."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
import inspect
import re
import types
from typing import Callable, Literal, Union, get_args, get_origin, get_type_hints


_FUNCTION_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_SECTION = re.compile(
    r"^(Args|Arguments|Parameters|Params|Returns?|Yields?|Raises?|Examples?|Notes?"
    r"|Attributes|Warnings?|See Also|Todo):\s*$"
)
_ARGUMENT = re.compile(r"^\*{0,2}(\w+)\s*(?:\(([^)]*)\))?\s*:\s*(.*)$")


@dataclass(frozen=True)
class Function:
    name: str
    description: str
    parameters: dict[str, object]
    entrypoint: Callable[..., object]

    def __post_init__(self) -> None:
        if _FUNCTION_NAME.fullmatch(self.name) is None:
            raise ValueError(
                f"Function name {self.name!r} must be lowercase snake_case, "
                "at most 64 characters"
            )
        if not isinstance(self.description, str):
            raise TypeError(f"Function {self.name} description must be a string")
        if not isinstance(self.parameters, dict) or self.parameters.get("type") != "object":
            raise ValueError(
                f'Function {self.name} parameters must be a JSON Schema with type "object"'
            )
        if not callable(self.entrypoint):
            raise TypeError(f"Function {self.name} entrypoint must be callable")
        if inspect.iscoroutinefunction(self.entrypoint):
            raise TypeError(f"Function {self.name} must not be async")

    def __call__(self, *args: object, **kwargs: object) -> object:
        return self.entrypoint(*args, **kwargs)


def tool(
    function: Callable[..., object],
    *,
    name: str | None = None,
    description: str | None = None,
) -> Function:
    """The schema comes from the type hints and a Google-style docstring.

    Parameters without a default are required.
    """
    if isinstance(function, Function):
        return function
    if not callable(function):
        raise TypeError("tool needs a function")
    if inspect.iscoroutinefunction(function):
        raise TypeError(f"Function {_callable_name(function)} must not be async")
    docstring = inspect.getdoc(function) or ""
    summary, argument_docs = _parse_docstring(docstring)
    return Function(
        name=name if name is not None else _callable_name(function),
        description=description if description is not None else summary,
        parameters=_parameters(function, argument_docs),
        entrypoint=function,
    )


def _callable_name(function: Callable[..., object]) -> str:
    return str(getattr(function, "__name__", type(function).__name__))


def _parameters(
    function: Callable[..., object],
    argument_docs: dict[str, str],
) -> dict[str, object]:
    signature = inspect.signature(function)
    hints = _type_hints(function)
    properties: dict[str, object] = {}
    required: list[str] = []
    for parameter in signature.parameters.values():
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        if parameter.kind is parameter.POSITIONAL_ONLY:
            raise ValueError(
                f"Function {_callable_name(function)} parameter {parameter.name} "
                "is positional-only; the model passes arguments by name"
            )
        schema = _schema_for(hints[parameter.name]) if parameter.name in hints else {}
        if argument_docs.get(parameter.name):
            schema["description"] = argument_docs[parameter.name]
        properties[parameter.name] = schema
        if parameter.default is parameter.empty:
            required.append(parameter.name)
    return {"type": "object", "properties": properties, "required": required}


def _type_hints(function: Callable[..., object]) -> dict[str, object]:
    try:
        return get_type_hints(function)
    except NameError:
        pass
    # A hint naming a class local to a function cannot be resolved; it stays unannotated.
    namespace = getattr(function, "__globals__", {})
    hints: dict[str, object] = {}
    for name, annotation in inspect.get_annotations(function).items():
        if not isinstance(annotation, str):
            hints[name] = annotation
            continue
        try:
            hints[name] = eval(annotation, namespace)
        except NameError:
            continue
    return hints


def _schema_for(hint: object) -> dict[str, object]:
    origin = get_origin(hint)
    arguments = get_args(hint)
    if origin is Literal:
        return _literal_schema(arguments)
    if origin in (Union, types.UnionType):
        members = [argument for argument in arguments if argument is not type(None)]
        # Optional[X] is X: the model omits the argument rather than sending null.
        if len(members) == 1 and len(arguments) == 2:
            return _schema_for(members[0])
        return {"anyOf": [_schema_for(argument) for argument in arguments]}
    if origin in (list, tuple, set, frozenset):
        items = _schema_for(arguments[0]) if arguments else {"type": "string"}
        return {"type": "array", "items": items}
    if origin is dict:
        values = _schema_for(arguments[1]) if len(arguments) > 1 else {"type": "string"}
        return {"type": "object", "additionalProperties": values}
    if hint is None or hint is type(None):
        return {"type": "null"}
    if isinstance(hint, type) and issubclass(hint, Enum):
        return {"type": "string", "enum": [member.value for member in hint]}
    if hint is bool:
        return {"type": "boolean"}
    if hint is int:
        return {"type": "integer"}
    if hint in (float, complex, Decimal):
        return {"type": "number"}
    if hint is str:
        return {"type": "string"}
    if hint in (list, tuple, set, frozenset):
        return {"type": "array"}
    if hint is dict:
        return {"type": "object", "additionalProperties": True}
    return {"type": "object"}


def _literal_schema(values: tuple[object, ...]) -> dict[str, object]:
    # bool is a subclass of int, so it is checked first.
    if all(isinstance(value, str) for value in values):
        return {"type": "string", "enum": list(values)}
    if all(isinstance(value, bool) for value in values):
        return {"type": "boolean", "enum": list(values)}
    if all(isinstance(value, int) and not isinstance(value, bool) for value in values):
        return {"type": "integer", "enum": list(values)}
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values):
        return {"type": "number", "enum": list(values)}
    return {"enum": list(values)}


def _parse_docstring(docstring: str) -> tuple[str, dict[str, str]]:
    """The text before the first section, and each Args entry as "(type) text"."""
    summary: list[str] = []
    arguments: dict[str, str] = {}
    section: str | None = None
    current: str | None = None
    entry_indent: int | None = None
    for line in docstring.splitlines():
        heading = _SECTION.match(line)
        if heading is not None:
            section = heading.group(1)
            current = None
            entry_indent = None
            continue
        if section is None:
            summary.append(line)
            continue
        if section not in ("Args", "Arguments", "Parameters", "Params") or not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        entry = _ARGUMENT.match(line.strip())
        if entry is not None and (entry_indent is None or indent <= entry_indent):
            entry_indent = indent
            current = entry.group(1)
            kind, text = entry.group(2), entry.group(3).strip()
            arguments[current] = f"({kind}) {text}" if kind else text
        elif current is not None:
            arguments[current] = f"{arguments[current]} {line.strip()}".strip()
    return "\n".join(summary).strip(), arguments
