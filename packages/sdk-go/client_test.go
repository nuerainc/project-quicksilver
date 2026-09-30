package quicksilver

import (
	"context"
	"errors"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewClientRequiresHTTPSOutsideLoopback(t *testing.T) {
	for _, url := range []string{"http://api.example.com", "not a URL", ""} {
		t.Run(url, func(t *testing.T) {
			if _, err := NewClient(ClientOptions{BaseURL: url}); err == nil {
				t.Fatal("expected invalid URL to be rejected")
			}
		})
	}
	for _, url := range []string{"http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"} {
		if _, err := NewClient(ClientOptions{BaseURL: url}); err != nil {
			t.Errorf("loopback URL %q rejected: %v", url, err)
		}
	}
	if _, err := NewClient(ClientOptions{BaseURL: "ftp://localhost:3000"}); err == nil {
		t.Fatal("unsupported loopback scheme should be rejected")
	}
}

func TestValidateWorkflowContractAndHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/workflows/validate" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("missing SDK headers: %v", r.Header)
		}
		var request struct {
			Graph map[string]any `json:"graph"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Graph["name"] != "example" {
			t.Errorf("invalid request body: %+v (%v)", request, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"schemaVersion":1,"valid":true,"errors":[],"topologicalOrder":["start"]}`))
	}))
	defer server.Close()

	headers := make(http.Header)
	headers.Set("Authorization", "Bearer test")
	client, err := NewClient(ClientOptions{BaseURL: server.URL, Headers: headers})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.ValidateWorkflow(context.Background(), map[string]any{"name": "example"})
	if err != nil || !result.Valid || len(result.TopologicalOrder) != 1 || result.TopologicalOrder[0] != "start" {
		t.Fatalf("unexpected validation result: %+v, %v", result, err)
	}
}

func TestPreviewWorkflowRejectsUnsafeOrIncompleteResponses(t *testing.T) {
	for name, body := range map[string]string{
		"valid":      `{"mode":"simulation","externalEffectsEnabled":false,"status":"completed","outputs":{},"steps":[{"nodeId":"n","status":"completed"}]}`,
		"effects":    `{"mode":"simulation","externalEffectsEnabled":true,"status":"completed","outputs":{},"steps":[]}`,
		"no steps":   `{"mode":"simulation","externalEffectsEnabled":false,"status":"completed","outputs":{},"steps":null}`,
		"bad status": `{"mode":"simulation","externalEffectsEnabled":false,"status":"unknown","outputs":{},"steps":[]}`,
		"bad step":   `{"mode":"simulation","externalEffectsEnabled":false,"status":"completed","outputs":{},"steps":[{"nodeId":"n","status":"unknown"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := jsonServer(body)
			defer server.Close()
			client, err := NewClient(ClientOptions{BaseURL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.PreviewWorkflow(context.Background(), map[string]any{})
			if (name == "valid") != (err == nil) {
				t.Fatalf("unexpected error result: %v", err)
			}
		})
	}
}

func TestReadOnlyRunRejectsMalformedEvaluations(t *testing.T) {
	for name, evaluation := range map[string]string{
		"missing score": `{"hallucinationRisk":"low","brittleness":"low","safetyDecision":"ALLOW","issues":[],"corrections":[]}`,
		"bad risk": `{"reasoningScore":80,"hallucinationRisk":"certain","brittleness":"low","safetyDecision":"ALLOW","issues":[],"corrections":[]}`,
		"score out of range": `{"reasoningScore":101,"hallucinationRisk":"low","brittleness":"low","safetyDecision":"ALLOW","issues":[],"corrections":[]}`,
		"missing lists": `{"reasoningScore":80,"hallucinationRisk":"low","brittleness":"low","safetyDecision":"ALLOW"}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := jsonServer(`{"mode":"live-read-only","externalEffectsEnabled":false,"status":"completed","outputs":{},"steps":[],"evaluations":{"query":` + evaluation + `}}`)
			defer server.Close()
			client, _ := NewClient(ClientOptions{BaseURL: server.URL})
			if _, err := client.RunReadOnlyWorkflow(context.Background(), map[string]any{}, "hello"); err == nil {
				t.Fatal("malformed evaluation should be rejected")
			}
		})
	}
}

func TestReadOnlyRunRequiresEvaluationsAndValidInput(t *testing.T) {
	server := jsonServer(`{"mode":"live-read-only","externalEffectsEnabled":false,"status":"completed","outputs":{},"steps":[],"evaluations":{"query":{"reasoningScore":80,"hallucinationRisk":"low","brittleness":"low","safetyDecision":"ALLOW","issues":[],"corrections":[]}}}`)
	defer server.Close()
	client, err := NewClient(ClientOptions{BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.RunReadOnlyWorkflow(context.Background(), map[string]any{}, "hello"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RunReadOnlyWorkflow(context.Background(), map[string]any{}, "no"); err == nil {
		t.Fatal("short input should be rejected")
	}
}

func TestStructuredHTTPErrorAndResponseSizeLimit(t *testing.T) {
	server := jsonServerStatus(`{"error":"denied","extra":true}`, http.StatusForbidden)
	defer server.Close()
	client, err := NewClient(ClientOptions{BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ValidateWorkflow(context.Background(), map[string]any{})
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.StatusCode != http.StatusForbidden || apiError.Message != "denied" || !strings.Contains(string(apiError.ResponseBody), "extra") {
		t.Fatalf("structured error was not preserved: %#v", err)
	}

	large := jsonServer(strings.Repeat("x", maxResponseBytes+1))
	defer large.Close()
	largeClient, _ := NewClient(ClientOptions{BaseURL: large.URL})
	_, err = largeClient.ValidateWorkflow(context.Background(), map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("oversized response not rejected: %v", err)
	}
}

func TestContextCancellationStopsRequest(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	client, _ := NewClient(ClientOptions{BaseURL: server.URL})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := client.ValidateWorkflow(ctx, map[string]any{}); done <- err }()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func jsonServer(body string) *httptest.Server { return jsonServerStatus(body, http.StatusOK) }

func jsonServerStatus(body string, status int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}
