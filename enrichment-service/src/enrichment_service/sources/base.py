"""Source plugin interface."""

from __future__ import annotations

from abc import ABC, abstractmethod

import httpx

from ..models import Candidate, EnrichRequest


class Source(ABC):
    """A discovery source. Given a creator, returns normalized candidates only —
    never writes anything (all writes happen in the Node backend on accept)."""

    #: Stable identifier stored on every suggestion (e.g. "theporndb").
    name: str

    @abstractmethod
    async def search(
        self, request: EnrichRequest, client: httpx.AsyncClient
    ) -> list[Candidate]:
        """Return candidates for the given creator."""
        raise NotImplementedError
