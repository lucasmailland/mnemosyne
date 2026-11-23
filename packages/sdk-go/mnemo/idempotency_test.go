package mnemo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync/atomic"
	"testing"
)

// uuidV4Pattern matches a canonical RFC-4122 v4 UUID:
// xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y ∈ {8,9,a,b}.
var uuidV4Pattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

func TestNewIdempotencyKey_FormatV4(t *testing.T) {
	k, err := NewIdempotencyKey()
	if err != nil {
		t.Fatalf("NewIdempotencyKey returned error: %v", err)
	}
	if !uuidV4Pattern.MatchString(k) {
		t.Fatalf("key %q is not a canonical UUID v4", k)
	}
}

func TestNewIdempotencyKey_Unique(t *testing.T) {
	seen := make(map[string]struct{}, 1000)
	for i := 0; i < 1000; i++ {
		k, err := NewIdempotencyKey()
		if err != nil {
			t.Fatalf("NewIdempotencyKey error on iter %d: %v", i, err)
		}
		if _, dup := seen[k]; dup {
			t.Fatalf("duplicate key generated: %q", k)
		}
		seen[k] = struct{}{}
	}
}

func TestWithIdempotencyKey_SetsRequestOption(t *testing.T) {
	opts := applyRequestOptions(WithIdempotencyKey("fixed-key-123"))
	if opts.idempotencyKey != "fixed-key-123" {
		t.Fatalf("expected idempotencyKey 'fixed-key-123', got %q", opts.idempotencyKey)
	}
}

func TestApplyRequestOptions_EmptyByDefault(t *testing.T) {
	opts := applyRequestOptions()
	if opts.idempotencyKey != "" {
		t.Fatalf("expected empty idempotencyKey by default, got %q", opts.idempotencyKey)
	}
}

func TestDoOnce_SendsIdempotencyHeader(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Idempotency-Key")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, apiKey: "k", maxRetries: 3, http: srv.Client()}
	var out map[string]interface{}
	err := c.do(context.Background(), http.MethodPost, "/facts",
		map[string]string{"content": "x"}, &out,
		WithIdempotencyKey("key-abc"))
	if err != nil {
		t.Fatalf("do returned error: %v", err)
	}
	if got != "key-abc" {
		t.Fatalf("expected Idempotency-Key 'key-abc', server saw %q", got)
	}
}

func TestDoOnce_NoIdempotencyHeaderWhenUnset(t *testing.T) {
	present := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, present = r.Header["Idempotency-Key"]
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, apiKey: "k", maxRetries: 3, http: srv.Client()}
	if err := c.do(context.Background(), http.MethodPost, "/facts",
		map[string]string{"content": "x"}, nil); err != nil {
		t.Fatalf("do returned error: %v", err)
	}
	if present {
		t.Fatal("expected no Idempotency-Key header when option not supplied")
	}
}

func TestDoOnce_IdempotencyKeyStableAcrossRetries(t *testing.T) {
	var n int32
	keys := make([]string, 0, 3)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		if atomic.AddInt32(&n, 1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, apiKey: "k", maxRetries: 3, http: srv.Client()}
	var out map[string]interface{}
	if err := c.do(context.Background(), http.MethodPost, "/facts",
		map[string]string{"content": "x"}, &out,
		WithIdempotencyKey("stable-key")); err != nil {
		t.Fatalf("do returned error: %v", err)
	}
	if len(keys) != 3 {
		t.Fatalf("expected 3 attempts, got %d", len(keys))
	}
	for i, k := range keys {
		if k != "stable-key" {
			t.Fatalf("attempt %d sent key %q, want 'stable-key'", i, k)
		}
	}
}

func TestCreateFact_ForwardsIdempotencyKey(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Idempotency-Key")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"f-1"}`))
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, apiKey: "k", maxRetries: 3, http: srv.Client()}
	if _, err := c.CreateFact(context.Background(),
		FactInput{Content: "hello"}, WithIdempotencyKey("ck-create")); err != nil {
		t.Fatalf("CreateFact error: %v", err)
	}
	if got != "ck-create" {
		t.Fatalf("CreateFact did not forward key; server saw %q", got)
	}
}

func TestForgetFact_ForwardsIdempotencyKey(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Idempotency-Key")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, apiKey: "k", maxRetries: 3, http: srv.Client()}
	if err := c.ForgetFact(context.Background(), "f-1", WithIdempotencyKey("ck-forget")); err != nil {
		t.Fatalf("ForgetFact error: %v", err)
	}
	if got != "ck-forget" {
		t.Fatalf("ForgetFact did not forward key; server saw %q", got)
	}
}

func TestPatchFact_ForwardsIdempotencyKey(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Idempotency-Key")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"f-1"}`))
	}))
	defer srv.Close()

	c := &Client{baseURL: srv.URL, apiKey: "k", maxRetries: 3, http: srv.Client()}
	if _, err := c.PatchFact(context.Background(), "f-1",
		map[string]interface{}{"pinned": true}, WithIdempotencyKey("ck-patch")); err != nil {
		t.Fatalf("PatchFact error: %v", err)
	}
	if got != "ck-patch" {
		t.Fatalf("PatchFact did not forward key; server saw %q", got)
	}
}
