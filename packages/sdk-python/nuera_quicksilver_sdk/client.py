"""Dependency-free synchronous client for Nuera Quicksilver."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class QuicksilverApiError(RuntimeError):
    """HTTP or response-contract error returned by the Quicksilver API."""

    def __init__(self, message: str, status: int | None = None, response_body: Any = None):
        super().__init__(message)
        self.status = status
        self.response_body = response_body


@dataclass(frozen=True)
class WorkflowValidationResponse:
    schema_version: int
    valid: bool
    errors: tuple[str, ...]
    topological_order: tuple[str, ...]


@dataclass(frozen=True)
class WorkflowStep:
    node_id: str
    status: str
    safety_decision: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class WorkflowRunResponse:
    mode: str
    external_effects_enabled: bool
    status: str
    outputs: Mapping[str, Any]
    steps: tuple[WorkflowStep, ...]
    evaluations: Mapping[str, Mapping[str, Any]]
    error: str | None = None


class _Transport(Protocol):
    def __call__(self, url: str, body: bytes, headers: Mapping[str, str], timeout: float) -> tuple[int, bytes]: ...


def _urlopen_transport(url: str, body: bytes, headers: Mapping[str, str], timeout: float) -> tuple[int, bytes]:
    request_headers = {"content-type": "application/json", **headers}
    request = Request(url, data=body, headers=request_headers, method="POST")
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()
    except URLError as error:
        raise QuicksilverApiError(f"Could not reach the Quicksilver API: {error.reason}") from error


class QuicksilverClient:
    """Client for validation, safe preview, and opt-in read-only workflow runs."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        headers: Mapping[str, str] | None = None,
        transport: _Transport | None = None,
    ):
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Quicksilver API URLs must use HTTPS outside localhost.")
        if not parsed.scheme or not parsed.netloc:
            raise ValueError("Provide a complete Quicksilver API URL.")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a finite number greater than zero.")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers = dict(headers or {})
        self._transport = transport or _urlopen_transport

    def validate_workflow(self, graph: Mapping[str, Any]) -> WorkflowValidationResponse:
        body = self._post("/api/workflows/validate", {"graph": graph}, _is_validation)
        return WorkflowValidationResponse(
            schema_version=body["schemaVersion"],
            valid=body["valid"],
            errors=tuple(body["errors"]),
            topological_order=tuple(body["topologicalOrder"]),
        )

    def preview_workflow(self, graph: Mapping[str, Any]) -> WorkflowRunResponse:
        body = self._post("/api/workflows/simulate", {"graph": graph}, _is_run("simulation"))
        return _run_response(body)

    def run_read_only_workflow(self, graph: Mapping[str, Any], input: str) -> WorkflowRunResponse:
        """Run query-agent steps only; the server blocks workflow tool dispatch."""
        if not isinstance(input, str) or not 3 <= len(input) <= 2000:
            raise ValueError("input must contain between 3 and 2,000 characters.")
        body = self._post("/api/workflows/run", {"graph": graph, "input": input}, _is_run("live-read-only"))
        return _run_response(body)

    def _post(self, path: str, payload: Mapping[str, Any], validate: Callable[[Any], bool]) -> dict[str, Any]:
        try:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise ValueError(f"Request data must be valid JSON: {error}") from error
        status, raw = self._transport(f"{self.base_url}{path}", encoded, self.headers, self.timeout)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = None
        if status < 200 or status >= 300:
            message = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), str) else f"Quicksilver API request failed with status {status}."
            raise QuicksilverApiError(message, status, body)
        if not validate(body):
            raise QuicksilverApiError("Quicksilver returned a response that does not match the expected contract.", status, body)
        return body


def _is_validation(body: Any) -> bool:
    return isinstance(body, dict) and body.get("schemaVersion") == 1 and isinstance(body.get("valid"), bool) \
        and isinstance(body.get("errors"), list) and all(isinstance(item, str) for item in body["errors"]) \
        and isinstance(body.get("topologicalOrder"), list) and all(isinstance(item, str) for item in body["topologicalOrder"])


def _is_run(mode: str) -> Callable[[Any], bool]:
    def validate(body: Any) -> bool:
        if not isinstance(body, dict) or body.get("mode") != mode or body.get("externalEffectsEnabled") is not False:
            return False
        status = body.get("status")
        if not isinstance(status, str) or status not in {"completed", "blocked", "failed", "cancelled"} or not isinstance(body.get("outputs"), dict):
            return False
        steps = body.get("steps")
        if not isinstance(steps, list) or not all(
            isinstance(step, dict)
            and isinstance(step.get("nodeId"), str)
            and isinstance(step.get("status"), str)
            and step.get("status") in {"completed", "skipped", "blocked", "failed", "cancelled"}
            and (step.get("safetyDecision") is None or (isinstance(step.get("safetyDecision"), str) and step.get("safetyDecision") in {"ALLOW", "BLOCK", "ESCALATE"}))
            and (step.get("detail") is None or isinstance(step.get("detail"), str))
            for step in steps
        ):
            return False
        if mode == "live-read-only":
            evaluations = body.get("evaluations")
            if not isinstance(evaluations, dict):
                return False
            for evaluation in evaluations.values():
                if not isinstance(evaluation, dict) or not isinstance(evaluation.get("reasoningScore"), (int, float)):
                    return False
                if not isinstance(evaluation.get("hallucinationRisk"), str) or evaluation.get("hallucinationRisk") not in {"low", "med", "high"}:
                    return False
                if not isinstance(evaluation.get("brittleness"), str) or evaluation.get("brittleness") not in {"low", "med", "high"}:
                    return False
                if not isinstance(evaluation.get("safetyDecision"), str) or evaluation.get("safetyDecision") not in {"ALLOW", "BLOCK", "ESCALATE"}:
                    return False
                if not isinstance(evaluation.get("issues"), list) or not all(isinstance(item, str) for item in evaluation["issues"]):
                    return False
                if not isinstance(evaluation.get("corrections"), list) or not all(isinstance(item, str) for item in evaluation["corrections"]):
                    return False
        return body.get("error") is None or isinstance(body.get("error"), str)

    return validate


def _run_response(body: dict[str, Any]) -> WorkflowRunResponse:
    steps = tuple(
        WorkflowStep(
            node_id=step["nodeId"],
            status=step["status"],
            safety_decision=step.get("safetyDecision"),
            detail=step.get("detail"),
        )
        for step in body["steps"]
    )
    return WorkflowRunResponse(
        mode=body["mode"],
        external_effects_enabled=body["externalEffectsEnabled"],
        status=body["status"],
        outputs=body["outputs"],
        steps=steps,
        evaluations=body.get("evaluations", {}),
        error=body.get("error"),
    )
