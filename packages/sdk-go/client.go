package quicksilver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	maxRequestBytes  = 256 << 10
	maxResponseBytes = 1 << 20
)

// ClientOptions configures the Quicksilver API client.
type ClientOptions struct {
	// BaseURL is the API origin, optionally including a reverse-proxy path prefix.
	BaseURL string
	// HTTPClient may supply custom TLS roots or transport behavior. Its Timeout is
	// preserved; when nil, a client with a 30-second timeout is created.
	HTTPClient *http.Client
	// Headers are copied to every request. Use a gateway-issued credential here
	// when the deployment requires one; the SDK does not store or log secrets.
	Headers http.Header
}

// Client calls the workflow validation, safe simulation, and read-only run APIs.
type Client struct {
	baseURL string
	http    *http.Client
	headers http.Header
}

// NewClient creates a client and refuses cleartext HTTP outside loopback hosts.
func NewClient(options ClientOptions) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(options.BaseURL))
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return nil, fmt.Errorf("provide a complete Quicksilver API URL")
	}
	loopback := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return nil, fmt.Errorf("Quicksilver API URLs must use HTTPS outside localhost")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("Quicksilver API URL must not contain user information, a query, or a fragment")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, fmt.Errorf("Quicksilver API URL scheme must be http or https")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""

	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	headers := options.Headers.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	return &Client{baseURL: parsed.String(), http: httpClient, headers: headers}, nil
}

// WorkflowValidationResponse is returned by ValidateWorkflow.
type WorkflowValidationResponse struct {
	SchemaVersion   int      `json:"schemaVersion"`
	Valid           bool     `json:"valid"`
	Errors          []string `json:"errors"`
	TopologicalOrder []string `json:"topologicalOrder"`
}

// WorkflowStatus is an execution result status returned by simulation and runs.
type WorkflowStatus string

const (
	WorkflowCompleted  WorkflowStatus = "completed"
	WorkflowBlocked    WorkflowStatus = "blocked"
	WorkflowFailed     WorkflowStatus = "failed"
	WorkflowCancelled  WorkflowStatus = "cancelled"
)

// WorkflowStep is an observable result for one graph node. Authorization
// references are included when a protected step reached the executor.
type WorkflowStep struct {
	NodeID                   string `json:"nodeId"`
	Status                   string `json:"status"`
	SafetyDecision           string `json:"safetyDecision,omitempty"`
	Detail                   string `json:"detail,omitempty"`
	RetryAfterMS             int64  `json:"retryAfterMs,omitempty"`
	AuthorizationID          string `json:"authorizationId,omitempty"`
	AuthorizationFingerprint string `json:"authorizationFingerprint,omitempty"`
}

// WorkflowRunResponse is returned by PreviewWorkflow and RunReadOnlyWorkflow.
// Evaluations and audit are raw JSON so newer server fields remain accessible.
type WorkflowRunResponse struct {
	Mode                   string                    `json:"mode"`
	ExternalEffectsEnabled bool                      `json:"externalEffectsEnabled"`
	Status                 WorkflowStatus            `json:"status"`
	Outputs                map[string]any             `json:"outputs"`
	Steps                  []WorkflowStep            `json:"steps"`
	Evaluations            map[string]json.RawMessage `json:"evaluations,omitempty"`
	Audit                  json.RawMessage            `json:"audit,omitempty"`
	Error                  string                     `json:"error,omitempty"`
}

// APIError describes a non-2xx response. ResponseBody is preserved for
// structured diagnostics without discarding fields unknown to this SDK version.
type APIError struct {
	StatusCode   int
	Message      string
	ResponseBody json.RawMessage
}

func (e *APIError) Error() string { return e.Message }

// ValidateWorkflow asks the server to validate a workflow graph without running it.
func (c *Client) ValidateWorkflow(ctx context.Context, graph any) (WorkflowValidationResponse, error) {
	var response WorkflowValidationResponse
	if err := c.post(ctx, "/api/workflows/validate", map[string]any{"graph": graph}, &response); err != nil {
		return WorkflowValidationResponse{}, err
	}
	if response.SchemaVersion != 1 || response.Errors == nil || response.TopologicalOrder == nil {
		return WorkflowValidationResponse{}, fmt.Errorf("Quicksilver returned an invalid workflow validation response")
	}
	return response, nil
}

// PreviewWorkflow runs the server's no-model, no-tools workflow simulation.
func (c *Client) PreviewWorkflow(ctx context.Context, graph any) (WorkflowRunResponse, error) {
	var response WorkflowRunResponse
	if err := c.post(ctx, "/api/workflows/simulate", map[string]any{"graph": graph}, &response); err != nil {
		return WorkflowRunResponse{}, err
	}
	if err := validateRunResponse(response, "simulation"); err != nil {
		return WorkflowRunResponse{}, err
	}
	return response, nil
}

// RunReadOnlyWorkflow requests a live run. The server permits only its
// configured read-only query-agent path and must keep external effects disabled.
func (c *Client) RunReadOnlyWorkflow(ctx context.Context, graph any, input string) (WorkflowRunResponse, error) {
	if n := len(utf16.Encode([]rune(input))); n < 3 || n > 2000 {
		return WorkflowRunResponse{}, fmt.Errorf("input must contain between 3 and 2,000 characters")
	}
	var response WorkflowRunResponse
	if err := c.post(ctx, "/api/workflows/run", map[string]any{"graph": graph, "input": input}, &response); err != nil {
		return WorkflowRunResponse{}, err
	}
	if err := validateRunResponse(response, "live-read-only"); err != nil {
		return WorkflowRunResponse{}, err
	}
	if response.Evaluations == nil {
		return WorkflowRunResponse{}, fmt.Errorf("Quicksilver returned a read-only run without evaluations")
	}
	return response, nil
}

func validateRunResponse(response WorkflowRunResponse, expectedMode string) error {
	if response.Mode != expectedMode || response.ExternalEffectsEnabled {
		return fmt.Errorf("Quicksilver returned an unexpected workflow mode or enabled external effects")
	}
	switch response.Status {
	case WorkflowCompleted, WorkflowBlocked, WorkflowFailed, WorkflowCancelled:
	default:
		return fmt.Errorf("Quicksilver returned an invalid workflow status")
	}
	if response.Outputs == nil || response.Steps == nil {
		return fmt.Errorf("Quicksilver returned an incomplete workflow response")
	}
	return nil
}

func (c *Client) post(ctx context.Context, path string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("workflow request is not valid JSON: %w", err)
	}
	if len(body) > maxRequestBytes {
		return fmt.Errorf("workflow request exceeds the 256 KiB limit")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create Quicksilver request: %w", err)
	}
	request.Header = c.headers.Clone()
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("could not reach the Quicksilver API: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read Quicksilver response: %w", err)
	}
	if len(raw) > maxResponseBytes {
		return fmt.Errorf("Quicksilver response exceeds the 1 MiB limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var problem struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &problem)
		message := problem.Error
		if message == "" {
			message = fmt.Sprintf("Quicksilver API request failed with status %d", response.StatusCode)
		}
		return &APIError{StatusCode: response.StatusCode, Message: message, ResponseBody: append(json.RawMessage(nil), raw...)}
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("Quicksilver returned an invalid JSON response: %w", err)
	}
	return nil
}
