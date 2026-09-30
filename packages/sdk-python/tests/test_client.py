from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nuera_quicksilver_sdk import QuicksilverApiError, QuicksilverClient
from nuera_quicksilver_sdk.client import WorkflowRunResponse, WorkflowValidationResponse
from nuera_quicksilver_sdk import cli


GRAPH = {"nodes": [], "edges": []}
VALIDATION = {"schemaVersion": 1, "valid": True, "errors": [], "topologicalOrder": ["start"]}
EVALUATION = {
    "reasoningScore": 85, "hallucinationRisk": "low", "brittleness": "low",
    "safetyDecision": "ALLOW", "issues": [], "corrections": [],
}
SIMULATION = {
    "mode": "simulation", "externalEffectsEnabled": False, "status": "completed",
    "outputs": {}, "steps": [{"nodeId": "start", "status": "completed", "safetyDecision": "SKIPPED", "retryAfterMs": 0}],
}
LIVE_RUN = {
    "mode": "live-read-only", "externalEffectsEnabled": False, "status": "completed",
    "outputs": {}, "steps": [], "evaluations": {"query": EVALUATION},
}


class ClientTests(unittest.TestCase):
    def client(self, body, status=200):
        seen = {}

        def transport(url, raw, headers, timeout):
            seen.update(url=url, payload=json.loads(raw), headers=headers, timeout=timeout)
            return status, json.dumps(body).encode()

        return QuicksilverClient("https://qs.example.com/", headers={"authorization": "Bearer test"}, transport=transport), seen

    def test_https_policy_and_timeout_validation(self):
        for url in ("http://qs.example.com", "ftp://localhost:3000", "not a URL", ""):
            with self.subTest(url=url), self.assertRaises(ValueError):
                QuicksilverClient(url)
        for url in ("http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"):
            QuicksilverClient(url)
        for timeout in (0, -1, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                QuicksilverClient("https://qs.example.com", timeout=timeout)

    def test_validate_workflow_posts_json_and_returns_typed_contract(self):
        client, seen = self.client(VALIDATION)
        result = client.validate_workflow(GRAPH)
        self.assertTrue(result.valid)
        self.assertEqual(result.topological_order, ("start",))
        self.assertEqual(seen["url"], "https://qs.example.com/api/workflows/validate")
        self.assertEqual(seen["payload"], {"graph": GRAPH})
        self.assertEqual(seen["headers"]["authorization"], "Bearer test")

    def test_validation_rejects_malformed_success_contract(self):
        client, _ = self.client({**VALIDATION, "topologicalOrder": [1]})
        with self.assertRaises(QuicksilverApiError):
            client.validate_workflow(GRAPH)

    def test_preview_and_read_only_run_require_safe_modes_and_evaluations(self):
        client, _ = self.client(SIMULATION)
        step = client.preview_workflow(GRAPH).steps[0]
        self.assertEqual(step.safety_decision, "SKIPPED")
        self.assertEqual(step.retry_after_ms, 0)
        client, _ = self.client({**SIMULATION, "steps": [{"nodeId": "start", "status": "failed", "retryAfterMs": -1}]})
        with self.assertRaises(QuicksilverApiError):
            client.preview_workflow(GRAPH)
        client, _ = self.client({**SIMULATION, "externalEffectsEnabled": True})
        with self.assertRaises(QuicksilverApiError):
            client.preview_workflow(GRAPH)
        client, _ = self.client(LIVE_RUN)
        self.assertEqual(client.run_read_only_workflow(GRAPH, "hello").mode, "live-read-only")
        client, _ = self.client({**LIVE_RUN, "evaluations": {"query": {**EVALUATION, "reasoningScore": "85"}}})
        with self.assertRaises(QuicksilverApiError):
            client.run_read_only_workflow(GRAPH, "hello")
        client, _ = self.client({**LIVE_RUN, "evaluations": {"query": {**EVALUATION, "reasoningScore": 101}}})
        with self.assertRaises(QuicksilverApiError):
            client.run_read_only_workflow(GRAPH, "hello")

    def test_http_error_body_and_malformed_body_are_reported_safely(self):
        client, _ = self.client({"error": "denied"}, 403)
        with self.assertRaises(QuicksilverApiError) as caught:
            client.validate_workflow(GRAPH)
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.response_body, {"error": "denied"})
        client = QuicksilverClient("https://qs.example.com", transport=lambda *_: (502, b"not json"))
        with self.assertRaisesRegex(QuicksilverApiError, "status 502"):
            client.validate_workflow(GRAPH)

    def test_invalid_json_request_and_run_input_are_rejected_before_transport(self):
        called = False

        def transport(*_):
            nonlocal called
            called = True
            return 200, json.dumps(VALIDATION).encode()

        client = QuicksilverClient("https://qs.example.com", transport=transport)
        with self.assertRaises(ValueError):
            client.validate_workflow({"bad": float("nan")})
        with self.assertRaises(ValueError):
            client.run_read_only_workflow(GRAPH, "no")
        self.assertFalse(called)

    def test_cli_reads_graph_envelope_and_reports_json_result(self):
        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            def validate_workflow(self, graph):
                self.graph = graph
                return WorkflowValidationResponse(1, True, (), ())

            def preview_workflow(self, graph):
                self.graph = graph
                return WorkflowRunResponse("simulation", False, "completed", {}, (), {})

            def run_read_only_workflow(self, graph, input):
                self.graph = graph
                self.input = input
                return WorkflowRunResponse("live-read-only", False, "completed", {}, (), {})

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workflow.json"
            path.write_text(json.dumps({"graph": GRAPH}), encoding="utf-8")
            with patch.object(sys, "argv", ["qs", "--api-url", "https://qs.example.com", "validate", str(path)]), \
                 patch.object(cli, "QuicksilverClient", FakeClient), patch("sys.stdout") as stdout:
                self.assertEqual(cli.main(), 0)
                self.assertIn('"valid": true', "".join(call.args[0] for call in stdout.write.call_args_list))

            for command, extra in (("preview", []), ("run", ["--input", "hello"])):
                with self.subTest(command=command), \
                     patch.object(sys, "argv", ["qs", "--api-url", "https://qs.example.com", command, str(path), *extra]), \
                     patch.object(cli, "QuicksilverClient", FakeClient):
                    self.assertEqual(cli.main(), 0)


if __name__ == "__main__":
    unittest.main()
