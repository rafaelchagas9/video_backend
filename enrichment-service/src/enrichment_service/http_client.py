"""Lifespan-owned HTTP pools, never shared across asyncio event loops."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass

import httpx

from .config import get_settings


@dataclass
class _Pools:
    clients: dict[float, httpx.AsyncClient]


_pools: dict[asyncio.AbstractEventLoop, _Pools] = {}


def _client(timeout: float) -> httpx.AsyncClient:
    settings = get_settings()
    return httpx.AsyncClient(timeout=httpx.Timeout(
        timeout,
        connect=min(timeout, settings.connect_timeout_seconds),
        pool=min(timeout, settings.pool_timeout_seconds),
    ))


@asynccontextmanager
async def http_lifespan(_app=None) -> AsyncIterator[None]:
    """Reuse connections across routes; close pools when the application stops."""
    loop = asyncio.get_running_loop()
    existing = _pools.get(loop)
    if existing is not None:
        raise RuntimeError("An enrichment HTTP lifespan is already active on this event loop")

    settings = get_settings()
    async with AsyncExitStack() as stack:
        clients = {}
        for timeout in {settings.request_timeout_seconds, max(settings.request_timeout_seconds, 120)}:
            clients[timeout] = await stack.enter_async_context(_client(timeout))
        pools = _Pools(clients)
        _pools[loop] = pools
        try:
            yield
        finally:
            _pools.pop(loop, None)


@asynccontextmanager
async def http_client(*, timeout: float) -> AsyncIterator[httpx.AsyncClient]:
    pools = _pools.get(asyncio.get_running_loop())
    if pools is not None and timeout in pools.clients:
        # A request must not close the application's shared connection pool.
        yield pools.clients[timeout]
    else:
        # Standalone scripts/direct route tests have no ASGI lifespan.
        async with _client(timeout) as client:
            yield client
