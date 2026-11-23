package mnemo

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type localTransport func(*http.Request) (*http.Response, error)

func (f localTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDoRetriesOn503(t *testing.T) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&n, 1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, apiKey: "k", maxRetries: 3, http: srv.Client()}
	var out map[string]interface{}
	if err := c.do(context.Background(), http.MethodGet, "/test", nil, &out); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if n < 3 {
		t.Fatalf("expected 3 calls, got %d", n)
	}
}

func TestDoNoRetryOn400(t *testing.T) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&n, 1)
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"bad"}`))
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, apiKey: "k", maxRetries: 3, http: srv.Client()}
	var out map[string]interface{}
	if err := c.do(context.Background(), http.MethodGet, "/test", nil, &out); err == nil {
		t.Fatal("expected error on 400")
	}
	if n != 1 {
		t.Fatalf("expected 1 call, got %d", n)
	}
}

func TestPatchDoesNotReplayAfter500(t *testing.T) {
	var n int32
	transport := localTransport(func(r *http.Request) (*http.Response, error) {
		atomic.AddInt32(&n, 1)
		return &http.Response{StatusCode: 500, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"message":"failed"}}`))}, nil
	})
	c := &Client{baseURL: "http://test", apiKey: "k", maxRetries: 3, http: &http.Client{Transport: transport}}
	var out map[string]interface{}
	err := c.do(context.Background(), http.MethodPatch, "/facts/f-1", map[string]string{"statement": "changed"}, &out)
	apiErr, ok := err.(*APIError)
	if !ok || !apiErr.OutcomeUnknown {
		t.Fatalf("expected unknown outcome, got %v", err)
	}
	if n != 1 {
		t.Fatalf("expected one attempt, got %d", n)
	}
}

func TestCanonicalErrorMetadata(t *testing.T) {
	transport := localTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 400, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"code":"validation_error","message":"bad","request_id":"r-1","retryable":false,"details":{"issues":[{"path":"query"}]}}}`))}, nil
	})
	c := &Client{baseURL: "http://test", apiKey: "k", maxRetries: 1, http: &http.Client{Transport: transport}}
	var out map[string]interface{}
	err := c.do(context.Background(), http.MethodGet, "/test", nil, &out)
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.RequestID != "r-1" || apiErr.Details == nil || apiErr.Retryable == nil || *apiErr.Retryable {
		t.Fatalf("metadata missing: %+v", err)
	}
}

func TestWorkspaceAndSessionOnRemember(t *testing.T) {
	var workspace string
	var body map[string]interface{}
	transport := localTransport(func(r *http.Request) (*http.Response, error) {
		workspace = r.Header.Get("X-Workspace-Id")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 201, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"id":"f1","statement":"hello"}`))}, nil
	})
	c := (&Client{baseURL: "http://test", apiKey: "k", http: &http.Client{Transport: transport}}).ForWorkspace("ws-2")
	if _, err := c.CreateFact(context.Background(), FactInput{Content: "hello", SessionID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	if workspace != "ws-2" || body["sessionId"] != "s-1" {
		t.Fatalf("workspace=%q body=%v", workspace, body)
	}
}

func TestRecallSendsSessionID(t *testing.T) {
	var body map[string]interface{}
	transport := localTransport(func(r *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"hits":[]}`))}, nil
	})
	c := &Client{baseURL: "http://test", apiKey: "k", http: &http.Client{Transport: transport}}
	if _, err := c.Recall(context.Background(), RecallInput{Query: "q", SessionID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	if body["sessionId"] != "s-1" {
		t.Fatalf("body=%v", body)
	}
}

func TestRetryAfterRejectsMalformedDelta(t *testing.T) {
	if _, ok := parseRetryAfter("5junk"); ok {
		t.Fatal("malformed delta accepted")
	}
}

func TestSafeGetRetriesConnectionError(t *testing.T) {
	n := 0
	transport := localTransport(func(r *http.Request) (*http.Response, error) {
		n++
		if n == 1 {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})
	c := &Client{baseURL: "http://test", apiKey: "k", maxRetries: 1, http: &http.Client{Transport: transport}}
	var out map[string]interface{}
	if err := c.do(context.Background(), http.MethodGet, "/health", nil, &out); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("attempts=%d", n)
	}
}

func TestMutationTransportFailureReportsUnknownOutcome(t *testing.T) {
	transport := localTransport(func(r *http.Request) (*http.Response, error) {
		return nil, &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}
	})
	c := &Client{baseURL: "http://test", apiKey: "k", http: &http.Client{Transport: transport}}
	var out map[string]interface{}
	err := c.do(context.Background(), http.MethodPatch, "/facts/f-1", map[string]string{"statement": "changed"}, &out)
	transportErr, ok := err.(*TransportError)
	if !ok || !transportErr.OutcomeUnknown {
		t.Fatalf("expected unknown outcome, got %v", err)
	}
}

func TestRetryableFalsePreventsReplay(t *testing.T) {
	n := 0
	transport := localTransport(func(r *http.Request) (*http.Response, error) {
		n++
		return &http.Response{StatusCode: 503, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"message":"unavailable","retryable":false}}`))}, nil
	})
	c := &Client{baseURL: "http://test", apiKey: "k", maxRetries: 3, http: &http.Client{Transport: transport}}
	var out map[string]interface{}
	if err := c.do(context.Background(), http.MethodGet, "/health", nil, &out); err == nil {
		t.Fatal("expected error")
	}
	if n != 1 {
		t.Fatalf("attempts=%d", n)
	}
}

func TestWorkspaceTimeoutConfigurationIsIsolated(t *testing.T) {
	original, err := NewClient("http://test", "k")
	if err != nil {
		t.Fatal(err)
	}
	bound := original.ForWorkspace("ws-2")
	bound.SetTimeout(2 * time.Second)
	if original.http.Timeout == bound.http.Timeout {
		t.Fatal("bound client changed the original timeout")
	}
}

func TestTimeoutIsTypedAndTerminal(t *testing.T) {
	n := 0
	transport := localTransport(func(r *http.Request) (*http.Response, error) {
		n++
		return nil, context.DeadlineExceeded
	})
	c := &Client{baseURL: "http://test", apiKey: "k", maxRetries: 3, http: &http.Client{Transport: transport}}
	var out map[string]interface{}
	err := c.do(context.Background(), http.MethodGet, "/health", nil, &out)
	if _, ok := err.(*TimeoutError); !ok || n != 1 {
		t.Fatalf("error=%v attempts=%d", err, n)
	}
}

type failingBody struct{ err error }

func (b failingBody) Read([]byte) (int, error) { return 0, b.err }
func (b failingBody) Close() error             { return nil }

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "body stalled" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return false }

func bodyClient(calls *int32, body io.ReadCloser, status int) *Client {
	return &Client{baseURL: "http://test", apiKey: "k", maxRetries: 3, http: &http.Client{Transport: localTransport(func(*http.Request) (*http.Response, error) {
		atomic.AddInt32(calls, 1)
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: body}, nil
	})}}
}

func TestKeyedMutationBodyStallIsTimeoutWithUnknownOutcome(t *testing.T) {
	var calls int32
	c := bodyClient(&calls, failingBody{timeoutErr{}}, 200)
	err := c.do(context.Background(), http.MethodPost, "/remember", map[string]string{"statement": "x"}, nil, WithIdempotencyKey("k1"))
	te, ok := err.(*TimeoutError)
	if !ok {
		t.Fatalf("want *TimeoutError, got %T: %v", err, err)
	}
	if !te.OutcomeUnknown {
		t.Fatal("a keyed mutation that stalls after committing must report OutcomeUnknown")
	}
	if calls != 1 {
		t.Fatalf("timeouts are terminal, got %d calls", calls)
	}
}

func TestMutationBodyResetIsTransportErrorWithUnknownOutcome(t *testing.T) {
	var calls int32
	c := bodyClient(&calls, failingBody{syscall.ECONNRESET}, 200)
	err := c.do(context.Background(), http.MethodPost, "/remember", map[string]string{"statement": "x"}, nil)
	te, ok := err.(*TransportError)
	if !ok {
		t.Fatalf("want *TransportError, got %T: %v", err, err)
	}
	if !te.OutcomeUnknown || calls != 1 {
		t.Fatalf("OutcomeUnknown=%v calls=%d", te.OutcomeUnknown, calls)
	}
}

func TestMalformedSuccessBodyOnMutationIsResponseErrorNotReplayed(t *testing.T) {
	var calls int32
	c := bodyClient(&calls, io.NopCloser(strings.NewReader(`{"id": "f-`)), 200)
	var out map[string]interface{}
	err := c.do(context.Background(), http.MethodPost, "/remember", map[string]string{"statement": "x"}, &out, WithIdempotencyKey("k1"))
	re, ok := err.(*ResponseError)
	if !ok {
		t.Fatalf("want *ResponseError, got %T: %v", err, err)
	}
	if !re.OutcomeUnknown || calls != 1 {
		t.Fatalf("OutcomeUnknown=%v calls=%d", re.OutcomeUnknown, calls)
	}
}

func TestMalformedSuccessBodyOnReadIsKnownOutcome(t *testing.T) {
	var calls int32
	c := bodyClient(&calls, io.NopCloser(strings.NewReader(`{`)), 200)
	var out map[string]interface{}
	err := c.do(context.Background(), http.MethodGet, "/x", nil, &out)
	re, ok := err.(*ResponseError)
	if !ok || re.OutcomeUnknown {
		t.Fatalf("got %T %v", err, err)
	}
}
