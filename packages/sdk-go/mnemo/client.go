// Package mnemo provides a Go client for the Mnemosyne cognitive memory HTTP API.
//
// It uses only the Go standard library (net/http, encoding/json, crypto/rand,
// etc.) and has zero runtime dependencies.
//
// Example usage:
//
//	client, err := mnemo.NewClient("https://memory.example.com", "mns_live_…")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	result, err := client.Recall(ctx, mnemo.RecallInput{Query: "user preferences"})
//
// Idempotency (§34.9): mutating calls accept an optional Idempotency-Key so a
// retried request is deduplicated server-side. Generate one key before the
// first attempt and reuse it across retries:
//
//	key, _ := mnemo.NewIdempotencyKey()
//	fact, err := client.CreateFact(ctx,
//	    mnemo.FactInput{Content: "Acme prefers Spanish"},
//	    mnemo.WithIdempotencyKey(key))
//
// The key is held constant if the caller retries. Mutations are not replayed
// automatically because a failed response can follow a committed write.
package mnemo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultTimeout    = 30 * time.Second
	sdkVersion        = "0.1.0"
	sdkUserAgent      = "mnemosyne-sdk-go/" + sdkVersion
	defaultMaxRetries = 3
)

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

// APIError is returned when the server responds with a non-2xx status code.
type APIError struct {
	Status            int
	Message           string
	Code              string
	RequestID         string
	Details           map[string]interface{}
	Retryable         *bool
	RetryAfterSeconds *float64
	OutcomeUnknown    bool
}

// TimeoutError reports a request that exceeded its deadline.
type TimeoutError struct {
	Cause          error
	OutcomeUnknown bool
}

// TransportError reports a connection failure; OutcomeUnknown is true for mutations.
type TransportError struct {
	Cause          error
	OutcomeUnknown bool
}

// ResponseError reports a 2xx response whose body could not be decoded. For a
// mutation the write may already have committed (OutcomeUnknown); it is never
// replayed automatically.
type ResponseError struct {
	Cause          error
	OutcomeUnknown bool
}

func (e *ResponseError) Error() string {
	return fmt.Sprintf("mnemo: decode response: %v", e.Cause)
}
func (e *ResponseError) Unwrap() error { return e.Cause }

func classifyTransportErr(err error) error {
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return &TimeoutError{Cause: err}
	}
	return &TransportError{Cause: err}
}

func (e *TransportError) Error() string { return fmt.Sprintf("mnemo: transport error: %v", e.Cause) }
func (e *TransportError) Unwrap() error { return e.Cause }

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("mnemosyne: request timed out: %v", e.Cause)
}
func (e *TimeoutError) Unwrap() error { return e.Cause }

func (e *APIError) Error() string {
	if e.Message == fmt.Sprintf("HTTP %d", e.Status) {
		// The default message already names the status.
		if e.Code != "" {
			return fmt.Sprintf("mnemosyne: %s (%s)", e.Message, e.Code)
		}
		return "mnemosyne: " + e.Message
	}
	if e.Code != "" {
		return fmt.Sprintf("mnemosyne: HTTP %d %s (%s)", e.Status, e.Message, e.Code)
	}
	return fmt.Sprintf("mnemosyne: HTTP %d %s", e.Status, e.Message)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// Client is a zero-dependency Mnemosyne HTTP client.
// Construct one with NewClient; the zero value is not valid.
type Client struct {
	baseURL     string
	apiKey      string
	workspaceID string
	http        *http.Client
	maxRetries  int // 0 means use defaultMaxRetries (3)
}

// ForWorkspace returns an independent client bound to one workspace.
func (c *Client) ForWorkspace(workspaceID string) *Client {
	copy := *c
	copy.workspaceID = workspaceID
	httpCopy := *c.http
	copy.http = &httpCopy
	return &copy
}

// NewClient creates a new Client.
// baseURL must not be empty (e.g. "https://memory.example.com").
// apiKey must not be empty (e.g. "mns_live_…").
func NewClient(baseURL, apiKey string) (*Client, error) {
	if baseURL == "" {
		return nil, fmt.Errorf("mnemo: baseURL is required")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("mnemo: apiKey is required")
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: defaultTimeout},
	}, nil
}

// SetTimeout changes the HTTP timeout for future requests.
func (c *Client) SetTimeout(timeout time.Duration) {
	if timeout > 0 {
		c.http.Timeout = timeout
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// doOnce performs a single HTTP request/response cycle. It is the inner
// function that do() calls on each attempt.
func (c *Client) doOnce(ctx context.Context, method, path string, body, out interface{}, opts requestOptions) error {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("mnemo: marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("mnemo: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("User-Agent", sdkUserAgent)
	req.Header.Set("Accept", "application/json")
	if c.workspaceID != "" {
		req.Header.Set("X-Workspace-Id", c.workspaceID)
	}
	// §34.9 — Idempotency-Key is set identically on every attempt because
	// doOnce is re-invoked with the same opts on each retry from do().
	if opts.idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", opts.idempotencyKey)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return classifyTransportErr(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil
	}

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		// A stall or reset after the headers arrived is still a timeout or a
		// transport failure, and a committed write may sit behind it.
		return classifyTransportErr(err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiErr := &APIError{
			Status:    resp.StatusCode,
			RequestID: resp.Header.Get("x-request-id"),
			Message:   fmt.Sprintf("HTTP %d", resp.StatusCode),
		}
		var envelope struct {
			Error struct {
				Message           string                 `json:"message"`
				Code              string                 `json:"code"`
				RequestID         string                 `json:"request_id"`
				Details           map[string]interface{} `json:"details"`
				Issues            []interface{}          `json:"issues"`
				Retryable         *bool                  `json:"retryable"`
				RetryAfterSeconds *float64               `json:"retryAfterSeconds"`
			} `json:"error"`
			RequestID string `json:"requestId"`
		}
		if jsonErr := json.Unmarshal(respBytes, &envelope); jsonErr == nil {
			if envelope.Error.Message != "" {
				apiErr.Message = envelope.Error.Message
			}
			if envelope.Error.Code != "" {
				apiErr.Code = envelope.Error.Code
			}
			apiErr.Details = envelope.Error.Details
			if apiErr.Details == nil && envelope.Error.Issues != nil {
				apiErr.Details = map[string]interface{}{"issues": envelope.Error.Issues}
			}
			apiErr.Retryable = envelope.Error.Retryable
			apiErr.RetryAfterSeconds = envelope.Error.RetryAfterSeconds
			if envelope.Error.RequestID != "" {
				apiErr.RequestID = envelope.Error.RequestID
			}
			if envelope.RequestID != "" {
				apiErr.RequestID = envelope.RequestID
			}
		} else if len(respBytes) > 0 {
			cut := respBytes
			if len(cut) > 500 {
				cut = cut[:500]
			}
			apiErr.Message = string(cut)
		}
		if delay, ok := parseRetryAfter(resp.Header.Get("Retry-After")); ok {
			apiErr.RetryAfterSeconds = &delay
		}
		return apiErr
	}

	if out != nil {
		if err := json.Unmarshal(respBytes, out); err != nil {
			return &ResponseError{Cause: err}
		}
	}
	return nil
}

func parseRetryAfter(value string) (float64, bool) {
	if value == "" {
		return 0, false
	}
	var seconds float64
	if parsed, err := strconv.ParseFloat(value, 64); err == nil && parsed >= 0 {
		seconds = parsed
		return seconds, true
	}
	if when, err := http.ParseTime(value); err == nil {
		return max(0, time.Until(when).Seconds()), true
	}
	return 0, false
}

// isRetryableStatus returns true for status codes that warrant a retry.
func isRetryableStatus(status int) bool {
	switch status {
	case http.StatusTooManyRequests,
		http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	}
	return false
}

// do executes the request with exponential backoff retry. It wraps doOnce and
// retries on 429/5xx up to c.maxRetries additional times. Context cancellation
// is respected during backoff sleeps.
func (c *Client) do(ctx context.Context, method, path string, body, out interface{}, options ...RequestOption) error {
	opts := applyRequestOptions(options...)
	maxRetries := c.maxRetries
	if maxRetries == 0 {
		maxRetries = defaultMaxRetries
	}

	var lastErr error
	// A mutation carrying an Idempotency-Key is safe to replay: the server dedups it.
	readOnly := method == http.MethodGet || (method == http.MethodPost && path == "/recall")
	replaySafe := readOnly || opts.idempotencyKey != ""
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			// Full-jitter exponential backoff: 200ms, 400ms, 800ms base
			base := time.Duration(200<<uint(attempt-1)) * time.Millisecond
			sleep := time.Duration(float64(base) * rand.Float64())
			if apiErr, ok := lastErr.(*APIError); ok && apiErr.RetryAfterSeconds != nil {
				sleep = time.Duration(*apiErr.RetryAfterSeconds * float64(time.Second))
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(sleep):
			}
		}

		err := c.doOnce(ctx, method, path, body, out, opts)
		if err == nil {
			return nil
		}
		if apiErr, ok := err.(*APIError); ok && !readOnly && apiErr.Status >= 500 {
			apiErr.OutcomeUnknown = true
		}
		if transportErr, ok := err.(*TransportError); ok && !readOnly {
			transportErr.OutcomeUnknown = true
		}
		if timeoutErr, ok := err.(*TimeoutError); ok && !readOnly {
			timeoutErr.OutcomeUnknown = true
		}
		if respErr, ok := err.(*ResponseError); ok && !readOnly {
			respErr.OutcomeUnknown = true
		}
		if !replaySafe || ctx.Err() != nil {
			return err
		}
		var timeoutErr *TimeoutError
		if errors.As(err, &timeoutErr) {
			return err
		}

		var apiErr *APIError
		if e, ok := err.(*APIError); ok && e.Retryable != nil && !*e.Retryable {
			return err
		}
		if ok := isAPIError(err, &apiErr); ok && !isRetryableStatus(apiErr.Status) {
			return err // Never retry 4xx or other non-retryable errors
		}
		if apiErr == nil {
			var opErr *net.OpError
			if !errors.As(err, &opErr) || opErr.Timeout() {
				return err
			}
		}
		lastErr = err
	}
	return lastErr
}

// isAPIError unwraps err into *APIError if possible.
func isAPIError(err error, target **APIError) bool {
	if err == nil {
		return false
	}
	if e, ok := err.(*APIError); ok {
		*target = e
		return true
	}
	return false
}

func (c *Client) get(ctx context.Context, path string, params url.Values, out interface{}, options ...RequestOption) error {
	p := path
	if len(params) > 0 {
		p = path + "?" + params.Encode()
	}
	return c.do(ctx, http.MethodGet, p, nil, out, options...)
}

func (c *Client) post(ctx context.Context, path string, body, out interface{}, options ...RequestOption) error {
	return c.do(ctx, http.MethodPost, path, body, out, options...)
}

func (c *Client) patch(ctx context.Context, path string, body, out interface{}, options ...RequestOption) error {
	return c.do(ctx, http.MethodPatch, path, body, out, options...)
}

func (c *Client) delete(ctx context.Context, path string, out interface{}, options ...RequestOption) error {
	return c.do(ctx, http.MethodDelete, path, nil, out, options...)
}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

// RecallInput holds parameters for the /recall endpoint.
type RecallInput struct {
	Query     string    `json:"query"`
	SessionID string    `json:"sessionId,omitempty"`
	Vector    []float64 `json:"vector,omitempty"`
	TopK      int       `json:"topK,omitempty"`
	// AsOf (RFC 3339, not in the future) ranks what memory held at that instant.
	AsOf         string  `json:"asOf,omitempty"`
	VectorWeight float64 `json:"vectorWeight,omitempty"`
}

// RecallResponse is the JSON response from POST /recall.
type RecallResponse struct {
	Hits  []map[string]interface{} `json:"hits"`
	Debug map[string]interface{}   `json:"debug,omitempty"`
}

// FactInput holds parameters for creating a fact.
type FactInput struct {
	Content     string                 `json:"content"`
	SessionID   string                 `json:"sessionId,omitempty"`
	Attribution map[string]interface{} `json:"attribution,omitempty"`
	Tags        []string               `json:"tags,omitempty"`
}

// PinInput is the body sent to POST /facts/:id/pin.
type PinInput struct {
	Pinned bool `json:"pinned"`
}

// FederationSyncInput is sent to POST /memory/federation/sync.
type FederationSyncInput struct {
	PeerID string `json:"peerId"`
}

// ApprovePeerInput is sent to POST /memory/federation/peers/:id/approve.
type ApprovePeerInput struct {
	NewCertDer string `json:"newCertDer"`
	IssuedAt   string `json:"issuedAt,omitempty"`
}

// ConsolidationInput is sent to POST /consolidation/trigger.
// Only Mode "fast" with DryRun false is currently supported; manual deep mode
// and dry runs return API status 422. The fields remain for API compatibility.
type ConsolidationInput struct {
	Mode   string `json:"mode,omitempty"`
	DryRun bool   `json:"dryRun,omitempty"`
}

// SelfEditInput is sent to POST /self/edit.
type SelfEditInput struct {
	Action    string `json:"action"`
	Target    string `json:"target"`
	Reason    string `json:"reason"`
	Content   string `json:"content,omitempty"`
	AgentID   string `json:"agentId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
}

// ---------------------------------------------------------------------------
// API methods — Recall
// ---------------------------------------------------------------------------

// Recall calls POST /recall.
func (c *Client) Recall(ctx context.Context, input RecallInput) (*RecallResponse, error) {
	var out RecallResponse
	if err := c.post(ctx, "/recall", input, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// API methods — Facts
// ---------------------------------------------------------------------------

// CreateFact calls POST /remember.
//
// POST /facts was deleted server-side (flatten-legacy-dual-core D2 step 2).
// This is a lossless body remap (/remember already accepts tags +
// attribution): {content, attribution, tags} -> {statement, attribution,
// tags}. The response is remapped back (statement -> content) into the
// returned map alongside the raw statement field, so an existing caller
// reading result["content"] keeps working and a new caller can read
// result["statement"]/result["conflict"] directly — this method's name and
// FactInput signature stay the same, only the wire route changed.
func (c *Client) CreateFact(ctx context.Context, input FactInput, options ...RequestOption) (map[string]interface{}, error) {
	body := struct {
		Statement   string                 `json:"statement"`
		Attribution map[string]interface{} `json:"attribution,omitempty"`
		Tags        []string               `json:"tags,omitempty"`
		SessionID   string                 `json:"sessionId,omitempty"`
	}{
		Statement:   input.Content,
		Attribution: input.Attribution,
		Tags:        input.Tags,
		SessionID:   input.SessionID,
	}
	var out map[string]interface{}
	if err := c.post(ctx, "/remember", body, &out, options...); err != nil {
		return nil, err
	}
	if statement, ok := out["statement"]; ok {
		out["content"] = statement
	}
	return out, nil
}

// GetFact calls GET /facts/:id.
func (c *Client) GetFact(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/facts/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListFacts calls GET /facts with optional query params.
func (c *Client) ListFacts(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/facts", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PatchFact calls PATCH /facts/:id.
func (c *Client) PatchFact(ctx context.Context, id string, fields map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/facts/"+id, fields, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ForgetFact calls DELETE /facts/:id.
func (c *Client) ForgetFact(ctx context.Context, id string, options ...RequestOption) error {
	return c.delete(ctx, "/facts/"+id, nil, options...)
}

// RestoreFact calls POST /facts/:id/restore.
func (c *Client) RestoreFact(ctx context.Context, id string, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/facts/"+id+"/restore", nil, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// PinFact calls POST /facts/:id/pin {pinned: true}.
func (c *Client) PinFact(ctx context.Context, id string, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/facts/"+id+"/pin", PinInput{Pinned: true}, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// UnpinFact calls POST /facts/:id/pin {pinned: false}.
func (c *Client) UnpinFact(ctx context.Context, id string, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/facts/"+id+"/pin", PinInput{Pinned: false}, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetFactCitations calls GET /facts/:id/citations.
func (c *Client) GetFactCitations(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/facts/"+id+"/citations", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Timeline / Graph / Health
// ---------------------------------------------------------------------------

// Timeline calls GET /timeline.
func (c *Client) Timeline(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/timeline", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Graph calls GET /graph.
func (c *Client) Graph(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/graph", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Health calls GET /health.
func (c *Client) Health(ctx context.Context) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/health", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ExportWorkspace calls GET /export.
func (c *Client) ExportWorkspace(ctx context.Context) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/export", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Audit calls GET /audit.
func (c *Client) Audit(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/audit", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// ListEntities calls GET /entities.
func (c *Client) ListEntities(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/entities", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetEntity calls GET /entities/:id.
func (c *Client) GetEntity(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/entities/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateEntity calls POST /entities.
func (c *Client) CreateEntity(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/entities", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateEntity calls PATCH /entities/:id.
func (c *Client) UpdateEntity(ctx context.Context, id string, fields map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/entities/"+id, fields, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ListEntityFacts calls GET /entities/:id/facts.
func (c *Client) ListEntityFacts(ctx context.Context, id string, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/entities/"+id+"/facts", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

// ListEpisodes calls GET /episodes.
func (c *Client) ListEpisodes(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/episodes", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetEpisode calls GET /episodes/:id.
func (c *Client) GetEpisode(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/episodes/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

// ListDecisions calls GET /decisions.
func (c *Client) ListDecisions(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/decisions", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetDecision calls GET /decisions/:id.
func (c *Client) GetDecision(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/decisions/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateDecision calls POST /decisions.
func (c *Client) CreateDecision(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/decisions", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// SupersedeDecision calls PATCH /decisions/:id {supersededById}.
func (c *Client) SupersedeDecision(ctx context.Context, id, supersededByID string, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/decisions/"+id, map[string]interface{}{"supersededById": supersededByID}, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

// ListRelations calls GET /relations.
func (c *Client) ListRelations(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/relations", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateRelation calls POST /relations.
func (c *Client) CreateRelation(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/relations", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// PatchRelation calls PATCH /relations/:id.
func (c *Client) PatchRelation(ctx context.Context, id string, fields map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/relations/"+id, fields, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

// ListCitations calls GET /citations.
func (c *Client) ListCitations(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/citations", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

// ListReview calls GET /review.
func (c *Client) ListReview(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/review", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ReviewCount calls GET /review/count.
func (c *Client) ReviewCount(ctx context.Context) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/review/count", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// EnqueueReview calls POST /review/enqueue.
func (c *Client) EnqueueReview(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/review/enqueue", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ResolveReview calls POST /review/:id/resolve.
func (c *Client) ResolveReview(ctx context.Context, id, resolution string, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/review/"+id+"/resolve", map[string]interface{}{"resolution": resolution}, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

// CreateSession calls POST /session/start.
func (c *Client) CreateSession(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/session/start", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// CollapseSession calls POST /session/:id/collapse.
func (c *Client) CollapseSession(ctx context.Context, id string, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/session/"+id+"/collapse", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// AppendTurnInput is sent to POST /session/:id/turn.
type AppendTurnInput struct {
	// Role is the conversation participant role (e.g. "user", "assistant").
	Role string `json:"role"`
	// Content is the text of the turn.
	Content string `json:"content"`
	// No Metadata: a turn stores only role and content; the server answers
	// 400 to unknown fields (APP-018).
}

// PinSessionTurnInput is sent to POST /session/:id/pin.
type PinSessionTurnInput struct {
	// TurnID is the identifier of the turn to pin or unpin.
	TurnID string `json:"turnId"`
	// Pinned sets the pin state: true to pin, false to unpin.
	Pinned bool `json:"pinned"`
}

// AppendTurn calls POST /session/:id/turn (204 No Content → returns nil error on success).
func (c *Client) AppendTurn(ctx context.Context, id string, input AppendTurnInput, options ...RequestOption) error {
	return c.post(ctx, "/session/"+id+"/turn", input, nil, options...)
}

// PinSessionTurn calls POST /session/:id/pin (204 No Content → returns nil error on success).
func (c *Client) PinSessionTurn(ctx context.Context, id string, input PinSessionTurnInput, options ...RequestOption) error {
	return c.post(ctx, "/session/"+id+"/pin", input, nil, options...)
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

// TriggerConsolidation calls POST /consolidation/trigger.
// Only fast mode with DryRun false currently succeeds. Manual deep mode and
// dry runs return an APIError with status 422.
func (c *Client) TriggerConsolidation(ctx context.Context, input ConsolidationInput, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/consolidation/trigger", input, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

// CreateReminder calls POST /reminders.
func (c *Client) CreateReminder(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/reminders", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ListReminders calls GET /reminders.
func (c *Client) ListReminders(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/reminders", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DismissReminder calls DELETE /reminders/:id.
func (c *Client) DismissReminder(ctx context.Context, id string, options ...RequestOption) error {
	return c.delete(ctx, "/reminders/"+id, nil, options...)
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

// ListTasks calls GET /tasks.
func (c *Client) ListTasks(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/tasks", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateTask calls POST /tasks.
func (c *Client) CreateTask(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/tasks", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetTask calls GET /tasks/:id.
func (c *Client) GetTask(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/tasks/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PatchTask calls PATCH /tasks/:id.
func (c *Client) PatchTask(ctx context.Context, id string, fields map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/tasks/"+id, fields, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ArchiveTask calls DELETE /tasks/:id.
func (c *Client) ArchiveTask(ctx context.Context, id string, options ...RequestOption) error {
	return c.delete(ctx, "/tasks/"+id, nil, options...)
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// ListEvents calls GET /events.
func (c *Client) ListEvents(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/events", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateEvent calls POST /events.
func (c *Client) CreateEvent(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/events", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetEvent calls GET /events/:id.
func (c *Client) GetEvent(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/events/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ArchiveEvent calls DELETE /events/:id.
func (c *Client) ArchiveEvent(ctx context.Context, id string, options ...RequestOption) error {
	return c.delete(ctx, "/events/"+id, nil, options...)
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

// ListReasoning calls GET /reasoning.
func (c *Client) ListReasoning(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/reasoning", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateReasoning calls POST /reasoning.
func (c *Client) CreateReasoning(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/reasoning", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetReasoning calls GET /reasoning/:id.
func (c *Client) GetReasoning(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/reasoning/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PatchReasoning calls PATCH /reasoning/:id.
func (c *Client) PatchReasoning(ctx context.Context, id string, fields map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/reasoning/"+id, fields, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ArchiveReasoning calls DELETE /reasoning/:id.
func (c *Client) ArchiveReasoning(ctx context.Context, id string, options ...RequestOption) error {
	return c.delete(ctx, "/reasoning/"+id, nil, options...)
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

// ListStrategies calls GET /strategies.
func (c *Client) ListStrategies(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/strategies", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateStrategy calls POST /strategies.
func (c *Client) CreateStrategy(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/strategies", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetStrategy calls GET /strategies/:id.
func (c *Client) GetStrategy(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/strategies/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PatchStrategy calls PATCH /strategies/:id.
func (c *Client) PatchStrategy(ctx context.Context, id string, fields map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/strategies/"+id, fields, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ArchiveStrategy calls DELETE /strategies/:id.
func (c *Client) ArchiveStrategy(ctx context.Context, id string, options ...RequestOption) error {
	return c.delete(ctx, "/strategies/"+id, nil, options...)
}

// ---------------------------------------------------------------------------
// Hyperedges
// ---------------------------------------------------------------------------

// ListHyperedges calls GET /hyperedges.
func (c *Client) ListHyperedges(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/hyperedges", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateHyperedge calls POST /hyperedges.
func (c *Client) CreateHyperedge(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/hyperedges", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetHyperedge calls GET /hyperedges/:id.
func (c *Client) GetHyperedge(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/hyperedges/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PatchHyperedge calls PATCH /hyperedges/:id.
func (c *Client) PatchHyperedge(ctx context.Context, id string, fields map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/hyperedges/"+id, fields, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ArchiveHyperedge calls DELETE /hyperedges/:id.
func (c *Client) ArchiveHyperedge(ctx context.Context, id string, options ...RequestOption) error {
	return c.delete(ctx, "/hyperedges/"+id, nil, options...)
}

// ---------------------------------------------------------------------------
// Meta-cognition
// ---------------------------------------------------------------------------

// GetSelfModel calls GET /metacognition.
func (c *Client) GetSelfModel(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/metacognition", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Anticipation
// ---------------------------------------------------------------------------

// GetAnticipationFeed calls GET /anticipation.
func (c *Client) GetAnticipationFeed(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/anticipation", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

// ListCompositionRules calls GET /composition/rules.
func (c *Client) ListCompositionRules(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/composition/rules", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateCompositionRule calls POST /composition/rules.
func (c *Client) CreateCompositionRule(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/composition/rules", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetCompositionRule calls GET /composition/rules/:id.
func (c *Client) GetCompositionRule(ctx context.Context, id string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/composition/rules/"+id, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PatchCompositionRule calls PATCH /composition/rules/:id.
func (c *Client) PatchCompositionRule(ctx context.Context, id string, fields map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.patch(ctx, "/composition/rules/"+id, fields, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// DryRunComposition calls POST /composition/dry-run.
func (c *Client) DryRunComposition(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/composition/dry-run", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Self-editing
// ---------------------------------------------------------------------------

// SelfEdit calls POST /self/edit.
func (c *Client) SelfEdit(ctx context.Context, input SelfEditInput, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/self/edit", input, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// SelfReflect calls POST /self/reflect.
func (c *Client) SelfReflect(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/self/reflect", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetSelfProfile calls GET /self/profile.
func (c *Client) GetSelfProfile(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/self/profile", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

// ListFederationPeers calls GET /memory/federation/peers.
func (c *Client) ListFederationPeers(ctx context.Context) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/memory/federation/peers", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListPendingFederationPeers calls GET /memory/federation/peers/pending.
func (c *Client) ListPendingFederationPeers(ctx context.Context) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/memory/federation/peers/pending", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ApproveFederationPeer calls POST /memory/federation/peers/:id/approve.
func (c *Client) ApproveFederationPeer(ctx context.Context, id string, input ApprovePeerInput, options ...RequestOption) error {
	return c.do(ctx, http.MethodPost, "/memory/federation/peers/"+id+"/approve", input, nil, options...)
}

// ApproveFederationPeerKey calls POST /memory/federation/peers/:id/approve-key.
func (c *Client) ApproveFederationPeerKey(ctx context.Context, id string, input ApprovePeerInput, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/memory/federation/peers/"+id+"/approve-key", input, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteFederationPeer calls DELETE /memory/federation/peers/:id.
func (c *Client) DeleteFederationPeer(ctx context.Context, id string, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.delete(ctx, "/memory/federation/peers/"+id, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// ListFederationItems calls GET /memory/federation/items.
func (c *Client) ListFederationItems(ctx context.Context, params url.Values) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/memory/federation/items", params, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// TriggerFederationSync calls POST /memory/federation/sync.
func (c *Client) TriggerFederationSync(ctx context.Context, peerID string, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/memory/federation/sync", FederationSyncInput{PeerID: peerID}, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetFederationSyncJob calls GET /memory/federation/sync/:jobId.
func (c *Client) GetFederationSyncJob(ctx context.Context, jobID string) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.get(ctx, "/memory/federation/sync/"+jobID, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ResolveFederationConflict calls POST /memory/federation/resolve.
func (c *Client) ResolveFederationConflict(ctx context.Context, body map[string]interface{}, options ...RequestOption) (map[string]interface{}, error) {
	var out map[string]interface{}
	if err := c.post(ctx, "/memory/federation/resolve", body, &out, options...); err != nil {
		return nil, err
	}
	return out, nil
}
