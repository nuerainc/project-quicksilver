"""Command-line entry point for the Nuera Quicksilver Python SDK."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .client import QuicksilverApiError, QuicksilverClient


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="qs", description="Nuera Quicksilver workflow API client")
    parser.add_argument("--api-url", default=os.environ.get("QUICKSILVER_API_URL"), help="Quicksilver API base URL (or QUICKSILVER_API_URL)")
    parser.add_argument("--timeout", type=float, default=30.0, help="Request timeout in seconds")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("validate", "Validate a workflow JSON file"),
        ("preview", "Run a safe no-tools workflow simulation"),
        ("run", "Run an opt-in read-only query-agent workflow"),
    ):
        command = subparsers.add_parser(name, help=help_text)
        command.add_argument("workflow", type=Path, help="Workflow graph JSON file")
        if name == "run":
            command.add_argument("--input", required=True, help="Request passed to query-agent steps (3–2,000 characters)")
    return parser


def _read_graph(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not read workflow JSON: {error}") from error
    if isinstance(value, dict) and "graph" in value:
        value = value["graph"]
    if not isinstance(value, dict):
        raise ValueError("Workflow file must contain a graph object.")
    return value


def main() -> int:
    args = _parser().parse_args()
    if not args.api_url:
        print("Set --api-url or QUICKSILVER_API_URL.", file=sys.stderr)
        return 2
    try:
        graph = _read_graph(args.workflow)
        client = QuicksilverClient(args.api_url, timeout=args.timeout)
        if args.command == "validate":
            result = client.validate_workflow(graph)
        elif args.command == "preview":
            result = client.preview_workflow(graph)
        else:
            result = client.run_read_only_workflow(graph, args.input)
        print(json.dumps(asdict(result), indent=2, ensure_ascii=False))
        return 0 if getattr(result, "valid", True) and getattr(result, "status", "completed") == "completed" else 1
    except (ValueError, QuicksilverApiError) as error:
        print(str(error), file=sys.stderr)
        if isinstance(error, QuicksilverApiError) and error.response_body is not None:
            print(json.dumps(error.response_body, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
