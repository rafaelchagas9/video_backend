#!/usr/bin/env python
"""
GraphQL schema introspection for StashDB and ThePornDB.

Dumps the exact field-level shape of the types we care about (Performer, Studio,
Scene, Site, Tag, ...) so we can plan the DB schema changes (new fields, merges,
external-id mapping) before writing any migration.

Usage (from enrichment-service/):

    uv run python scripts/introspect_schema.py --endpoint stashdb
    uv run python scripts/introspect_schema.py --endpoint tpdb
    uv run python scripts/introspect_schema.py --endpoint stashdb --type Performer
    uv run python scripts/introspect_schema.py --endpoint tpdb --queries   # list root queries
    uv run python scripts/introspect_schema.py --endpoint stashdb --save   # write tmp/*.schema.json

Keys are read from this folder's .env, falling back to the repo root ../.env.
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
from rich.rule import Rule

console = Console()

SCRIPT_DIR = Path(__file__).resolve().parent
SERVICE_DIR = SCRIPT_DIR.parent
REPO_ROOT = SERVICE_DIR.parent

# Default set of types to dump per endpoint.
DEFAULT_TYPES = ["Performer", "Studio", "Scene", "Site", "Tag", "Image", "URL", "Network"]

TYPE_REF = """
fragment TypeRef on __Type {
  kind name
  ofType { kind name
    ofType { kind name
      ofType { kind name
        ofType { kind name } } } }
}
"""

INTROSPECT_TYPE = (
    """
query IntrospectType($name: String!) {
  __type(name: $name) {
    name kind description
    fields { name description type { ...TypeRef } }
    inputFields { name type { ...TypeRef } }
    enumValues { name }
  }
}
"""
    + TYPE_REF
)

INTROSPECT_QUERIES = (
    """
query RootQueries {
  __schema {
    queryType {
      fields {
        name
        args { name type { ...TypeRef } }
        type { ...TypeRef }
      }
    }
  }
}
"""
    + TYPE_REF
)


def load_keys() -> None:
    load_dotenv(SERVICE_DIR / ".env", override=False)
    load_dotenv(REPO_ROOT / ".env", override=False)


def endpoint_config(name: str) -> tuple[str, dict[str, str]]:
    """Return (url, headers) for the chosen endpoint."""
    if name == "stashdb":
        key = os.getenv("STASHDB_API_KEY", "")
        url = os.getenv("STASHDB_ENDPOINT", "https://stashdb.org/graphql")
        return url, {"ApiKey": key, "Content-Type": "application/json"}
    if name == "tpdb":
        key = os.getenv("THEPORNDB_API_KEY", "")
        url = os.getenv("THEPORNDB_GRAPHQL", "https://theporndb.net/graphql")
        return url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    raise ValueError(f"unknown endpoint: {name}")


def unwrap_type(t: dict[str, Any] | None) -> str:
    """Render a GraphQL introspection type ref as e.g. '[Image!]!'."""
    if not t:
        return "?"
    kind = t.get("kind")
    if kind == "NON_NULL":
        return unwrap_type(t.get("ofType")) + "!"
    if kind == "LIST":
        return "[" + unwrap_type(t.get("ofType")) + "]"
    return t.get("name") or "?"


def gql(client: httpx.Client, url: str, headers: dict, query: str, variables: dict | None = None) -> dict:
    payload: dict[str, Any] = {"query": query}
    if variables:
        payload["variables"] = variables
    resp = client.post(url, headers=headers, json=payload)
    if resp.status_code != 200:
        return {"_http_error": resp.status_code, "_body": resp.text[:600]}
    return resp.json()


def dump_type(client: httpx.Client, url: str, headers: dict, type_name: str, save: bool) -> dict | None:
    data = gql(client, url, headers, INTROSPECT_TYPE, {"name": type_name})
    if "_http_error" in data:
        console.print(f"[red]{type_name}: HTTP {data['_http_error']} — {data['_body']}[/red]")
        return None
    if data.get("errors"):
        console.print(f"[red]{type_name}: {json.dumps(data['errors'])[:300]}[/red]")
        return None
    t = (data.get("data") or {}).get("__type")
    if not t:
        console.print(f"[yellow]{type_name}: not found in schema[/yellow]")
        return None

    console.print(Rule(f"[bold]{t['name']}[/bold]  ({t['kind']})"))
    if t.get("description"):
        console.print(f"[dim]{t['description']}[/dim]")

    if t.get("enumValues"):
        vals = ", ".join(v["name"] for v in t["enumValues"])
        console.print(f"  enum: {vals}")

    for f in t.get("fields") or []:
        type_str = unwrap_type(f["type"])
        desc = f" [dim]— {f['description']}[/dim]" if f.get("description") else ""
        console.print(f"  [cyan]{f['name']}[/cyan]: {type_str}{desc}")

    if t.get("inputFields"):
        console.print("  [dim](input fields:)[/dim]")
        for f in t["inputFields"]:
            console.print(f"    [green]{f['name']}[/green]: {unwrap_type(f['type'])}")

    if save:
        out = SERVICE_DIR / "tmp"
        out.mkdir(exist_ok=True)
        (out / f"{type_name}.schema.json").write_text(json.dumps(t, indent=2, ensure_ascii=False))

    return t


def list_root_queries(client: httpx.Client, url: str, headers: dict) -> None:
    data = gql(client, url, headers, INTROSPECT_QUERIES)
    if "_http_error" in data:
        console.print(f"[red]queries: HTTP {data['_http_error']} — {data['_body']}[/red]")
        return
    if data.get("errors"):
        console.print(f"[red]{json.dumps(data['errors'])[:300]}[/red]")
        return
    fields = (((data.get("data") or {}).get("__schema") or {}).get("queryType") or {}).get("fields") or []
    console.print(Rule("[bold]root queries[/bold]"))
    for f in fields:
        args = ", ".join(f"{a['name']}: {unwrap_type(a['type'])}" for a in f.get("args") or [])
        console.print(f"  [cyan]{f['name']}[/cyan]({args}) -> {unwrap_type(f['type'])}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Introspect StashDB / ThePornDB GraphQL schema.")
    parser.add_argument("--endpoint", choices=["stashdb", "tpdb"], required=True)
    parser.add_argument("--type", help="introspect a single type (default: a curated set)")
    parser.add_argument("--queries", action="store_true", help="list root query operations")
    parser.add_argument("--save", action="store_true", help="write tmp/<Type>.schema.json")
    args = parser.parse_args()

    load_keys()
    url, headers = endpoint_config(args.endpoint)
    console.print(f"endpoint: [bold]{url}[/bold]\n")

    with httpx.Client(timeout=30) as client:
        if args.queries:
            list_root_queries(client, url, headers)
            return 0
        types = [args.type] if args.type else DEFAULT_TYPES
        for type_name in types:
            dump_type(client, url, headers, type_name, args.save)
            console.print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
