from __future__ import annotations

from typing import Generic, TypeVar


R = TypeVar("R")


class Ticket(Generic[R]):
    def __init__(self, value: R) -> None:
        self._value = value

    def result(self) -> R:
        return self._value
