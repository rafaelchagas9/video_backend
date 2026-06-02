#!/usr/bin/env python
"""
Exploration script for the metadata-DB sources we plan to use in Phase 0/1.

It probes ThePornDB (REST) and StashDB (GraphQL) for a performer name and prints
what each API expects (request shape) and what it returns (response shape), so we
can design the source plugins from real data rather than guesswork.

Usage (from the enrichment-service/ dir):

    uv run python scripts/explore_apis.py "Riley Reid"
    uv run python scripts/explore_apis.py "Riley Reid" --source tpdb
    uv run python scripts/explore_apis.py "Riley Reid" --source stashdb --introspect
    uv run python scripts/explore_apis.py "Riley Reid" --raw            # dump full JSON
    uv run python scripts/explore_apis.py "Riley Reid" --save           # write *.dump.json

API keys are read from this folder's .env, falling back to the repo root ../.env.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule

console = Console()

SCRIPT_DIR = Path(__file__).resolve().parent
SERVICE_DIR = SCRIPT_DIR.parent
REPO_ROOT = SERVICE_DIR.parent


def load_keys() -> None:
    """Load env from local .env first, then fall back to the repo root .env."""
    load_dotenv(SERVICE_DIR / ".env", override=False)
    load_dotenv(REPO_ROOT / ".env", override=False)


def redact(token: str | None) -> str:
    if not token:
        return "<missing>"
    if len(token) <= 10:
        return "***"
    return f"{token[:6]}…{token[-4:]}"


def short(value: Any, limit: int = 120) -> str:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    return text if len(text) <= limit else text[: limit - 1] + "…"


def describe_shape(obj: Any, indent: int = 0, max_depth: int = 3) -> list[str]:
    """Render a compact 'field: type = sample' tree of a JSON object."""
    pad = "  " * indent
    lines: list[str] = []
    if indent >= max_depth:
        return [f"{pad}… (truncated)"]
    if isinstance(obj, dict):
        for key, val in obj.items():
            if isinstance(val, dict):
                lines.append(f"{pad}{key}: object")
                lines.extend(describe_shape(val, indent + 1, max_depth))
            elif isinstance(val, list):
                sample = val[0] if val else None
                kind = type(sample).__name__ if sample is not None else "empty"
                lines.append(f"{pad}{key}: array[{len(val)}] of {kind}")
                if isinstance(sample, (dict, list)):
                    lines.extend(describe_shape(sample, indent + 1, max_depth))
                elif sample is not None:
                    lines.append(f"{pad}  e.g. {short(sample)}")
            else:
                lines.append(f"{pad}{key}: {type(val).__name__} = {short(val)}")
    elif isinstance(obj, list):
        lines.append(f"{pad}array[{len(obj)}]")
        if obj:
            lines.extend(describe_shape(obj[0], indent + 1, max_depth))
    else:
        lines.append(f"{pad}{type(obj).__name__} = {short(obj)}")
    return lines


def save_dump(name: str, data: Any) -> None:
    out = SERVICE_DIR / "tmp"
    out.mkdir(exist_ok=True)
    path = out / f"{name}.dump.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    console.print(f"[dim]saved → {path.relative_to(SERVICE_DIR)}[/dim]")


# --------------------------------------------------------------------------- #
# ThePornDB (REST)
# --------------------------------------------------------------------------- #
def explore_theporndb(name: str, *, raw: bool, save: bool) -> None:
    console.print(Rule("[bold cyan]ThePornDB (REST)[/bold cyan]"))
    api_key = os.getenv("THEPORNDB_API_KEY")
    base = os.getenv("THEPORNDB_BASE_URL", "https://api.theporndb.net").rstrip("/")

    if not api_key:
        console.print("[red]THEPORNDB_API_KEY not set — skipping.[/red]")
        return

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": "enrichment-service/0.1 (exploration)",
    }
    search_url = f"{base}/performers"
    console.print(
        Panel(
            f"GET {search_url}?q={name}\n"
            f"Authorization: Bearer {redact(api_key)}\n"
            "Accept: application/json",
            title="request",
            border_style="cyan",
        )
    )

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(search_url, headers=headers, params={"q": name})
    except httpx.HTTPError as exc:
        console.print(f"[red]request failed: {exc}[/red]")
        return

    console.print(f"status: [bold]{resp.status_code}[/bold]  ({resp.headers.get('content-type')})")
    if resp.status_code != 200:
        console.print(Panel(short(resp.text, 500), title="error body", border_style="red"))
        return

    body = resp.json()
    results = body.get("data", body if isinstance(body, list) else [])
    console.print(f"results: [bold]{len(results)}[/bold]  (top-level keys: {list(body)[:8]})")

    if save:
        save_dump("theporndb_search", body)
    if raw:
        console.print_json(data=body)

    if not results:
        console.print("[yellow]no performers returned.[/yellow]")
        return

    first = results[0]
    console.print(Panel("\n".join(describe_shape(first)), title="performer[0] shape", border_style="cyan"))

    # Fetch full detail for the first hit to reveal the richer single-resource shape.
    perf_id = first.get("id") or first.get("_id") or first.get("uuid")
    if perf_id is not None:
        detail_url = f"{base}/performers/{perf_id}"
        console.print(f"\n[dim]fetching detail: GET {detail_url}[/dim]")
        try:
            with httpx.Client(timeout=30) as client:
                d = client.get(detail_url, headers=headers)
            if d.status_code == 200:
                detail = d.json().get("data", d.json())
                if save:
                    save_dump("theporndb_detail", detail)
                if raw:
                    console.print_json(data=detail)
                console.print(
                    Panel("\n".join(describe_shape(detail)), title=f"performer/{perf_id} shape", border_style="cyan")
                )
            else:
                console.print(f"[yellow]detail status {d.status_code}[/yellow]")
        except httpx.HTTPError as exc:
            console.print(f"[red]detail request failed: {exc}[/red]")


# --------------------------------------------------------------------------- #
# StashDB (GraphQL)
# --------------------------------------------------------------------------- #
SEARCH_PERFORMER_QUERY = """
query SearchPerformers($term: String!) {
  searchPerformer(term: $term) {
    id
    name
    disambiguation
    aliases
    gender
    birth_date
    country
    urls { url site { name url } }
    images { id url width height }
  }
}
"""

INTROSPECT_PERFORMER_QUERY = """
query IntrospectPerformer {
  __type(name: "Performer") {
    name
    fields {
      name
      type { name kind ofType { name kind ofType { name kind } } }
    }
  }
}
"""


def _gql(client: httpx.Client, endpoint: str, headers: dict, query: str, variables: dict | None = None):
    payload: dict[str, Any] = {"query": query}
    if variables:
        payload["variables"] = variables
    return client.post(endpoint, headers=headers, json=payload)


def explore_stashdb(name: str, *, raw: bool, save: bool, introspect: bool) -> None:
    console.print(Rule("[bold magenta]StashDB (GraphQL)[/bold magenta]"))
    api_key = os.getenv("STASHDB_API_KEY")
    endpoint = os.getenv("STASHDB_ENDPOINT", "https://stashdb.org/graphql")

    if not api_key:
        console.print("[red]STASHDB_API_KEY not set — skipping.[/red]")
        return

    headers = {
        "ApiKey": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "enrichment-service/0.1 (exploration)",
    }
    console.print(
        Panel(
            f"POST {endpoint}\n"
            f"ApiKey: {redact(api_key)}\n"
            f"body: {{ query: searchPerformer(term: \"{name}\") {{ … }} }}",
            title="request",
            border_style="magenta",
        )
    )

    with httpx.Client(timeout=30) as client:
        if introspect:
            console.print("[dim]introspecting Performer type…[/dim]")
            try:
                ir = _gql(client, endpoint, headers, INTROSPECT_PERFORMER_QUERY)
                if ir.status_code == 200 and "data" in ir.json():
                    fields = ir.json()["data"]["__type"]["fields"]
                    names = ", ".join(f["name"] for f in fields)
                    console.print(Panel(names, title="Performer fields", border_style="magenta"))
                    if save:
                        save_dump("stashdb_introspect", ir.json())
                else:
                    console.print(f"[yellow]introspection status {ir.status_code}[/yellow]")
                    console.print(short(ir.text, 400))
            except httpx.HTTPError as exc:
                console.print(f"[red]introspection failed: {exc}[/red]")

        try:
            resp = _gql(client, endpoint, headers, SEARCH_PERFORMER_QUERY, {"term": name})
        except httpx.HTTPError as exc:
            console.print(f"[red]request failed: {exc}[/red]")
            return

    console.print(f"status: [bold]{resp.status_code}[/bold]  ({resp.headers.get('content-type')})")
    try:
        body = resp.json()
    except json.JSONDecodeError:
        console.print(Panel(short(resp.text, 500), title="non-JSON body", border_style="red"))
        return

    if body.get("errors"):
        console.print(Panel(json.dumps(body["errors"], indent=2), title="GraphQL errors", border_style="red"))
        console.print("[dim]tip: re-run with --introspect to see the real Performer fields.[/dim]")

    results = (body.get("data") or {}).get("searchPerformer") or []
    console.print(f"results: [bold]{len(results)}[/bold]")

    if save:
        save_dump("stashdb_search", body)
    if raw:
        console.print_json(data=body)

    if results:
        console.print(
            Panel("\n".join(describe_shape(results[0])), title="performer[0] shape", border_style="magenta")
        )


# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description="Probe ThePornDB / StashDB APIs.")
    parser.add_argument("name", nargs="?", default="Riley Reid", help="performer name to search")
    parser.add_argument(
        "--source", choices=["tpdb", "stashdb", "both"], default="both", help="which API to probe"
    )
    parser.add_argument("--raw", action="store_true", help="print full JSON responses")
    parser.add_argument("--save", action="store_true", help="write responses to tmp/*.dump.json")
    parser.add_argument(
        "--introspect", action="store_true", help="(stashdb) print the GraphQL Performer type fields"
    )
    args = parser.parse_args()

    load_keys()
    console.print(f"Searching for: [bold green]{args.name}[/bold green]\n")

    if args.source in ("tpdb", "both"):
        explore_theporndb(args.name, raw=args.raw, save=args.save)
        console.print()
    if args.source in ("stashdb", "both"):
        explore_stashdb(args.name, raw=args.raw, save=args.save, introspect=args.introspect)

    return 0


if __name__ == "__main__":
    sys.exit(main())
