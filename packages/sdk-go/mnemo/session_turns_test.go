package mnemo_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/lucasmailland/mnemosyne/packages/sdk-go/mnemo"
)

// ---------------------------------------------------------------------------
// AppendTurn tests
// ---------------------------------------------------------------------------

func TestAppendTurn_Basic(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if !strings.HasSuffix(r.URL.Path, "/turn") {
			t.Errorf("expected path to end with /turn, got %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})

	err := c.AppendTurn(context.Background(), "ses_1", mnemo.AppendTurnInput{
		Role:    "user",
		Content: "Hello Go SDK!",
	})
	if err != nil {
		t.Fatalf("AppendTurn returned error: %v", err)
	}
}

func TestAppendTurn_SessionIDInPath(t *testing.T) {
	var capturedPath string
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	})

	err := c.AppendTurn(context.Background(), "ses_abc123", mnemo.AppendTurnInput{
		Role:    "assistant",
		Content: "I remember.",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := "/session/ses_abc123/turn"
	if capturedPath != expected {
		t.Errorf("path mismatch: want %q, got %q", expected, capturedPath)
	}
}

func TestAppendTurn_BodyContents(t *testing.T) {
	var body map[string]interface{}
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})

	err := c.AppendTurn(context.Background(), "ses_1", mnemo.AppendTurnInput{
		Role:    "user",
		Content: "payload test",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if body["role"] != "user" {
		t.Errorf("role: want %q, got %v", "user", body["role"])
	}
	if body["content"] != "payload test" {
		t.Errorf("content: want %q, got %v", "payload test", body["content"])
	}
	if _, ok := body["metadata"]; ok {
		t.Errorf("metadata must not be sent (APP-018): %v", body["metadata"])
	}
}

func TestAppendTurn_OmitsMetadataWhenNil(t *testing.T) {
	var body map[string]interface{}
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})

	err := c.AppendTurn(context.Background(), "ses_1", mnemo.AppendTurnInput{
		Role:    "user",
		Content: "no meta",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, exists := body["metadata"]; exists {
		t.Error("expected metadata to be absent when nil, but it was present")
	}
}

func TestAppendTurn_BearerAuth(t *testing.T) {
	var authHeader string
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	})

	_ = c.AppendTurn(context.Background(), "ses_1", mnemo.AppendTurnInput{
		Role:    "user",
		Content: "auth check",
	})
	if authHeader != "Bearer test-api-key" {
		t.Errorf("auth header: want %q, got %q", "Bearer test-api-key", authHeader)
	}
}

// ---------------------------------------------------------------------------
// PinSessionTurn tests
// ---------------------------------------------------------------------------

func TestPinSessionTurn_Pin(t *testing.T) {
	var capturedPath string
	var body map[string]interface{}
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})

	err := c.PinSessionTurn(context.Background(), "ses_1", mnemo.PinSessionTurnInput{
		TurnID: "turn_abc",
		Pinned: true,
	})
	if err != nil {
		t.Fatalf("PinSessionTurn returned error: %v", err)
	}
	if capturedPath != "/session/ses_1/pin" {
		t.Errorf("path: want %q, got %q", "/session/ses_1/pin", capturedPath)
	}
	if body["turnId"] != "turn_abc" {
		t.Errorf("turnId: want %q, got %v", "turn_abc", body["turnId"])
	}
	if body["pinned"] != true {
		t.Errorf("pinned: want true, got %v", body["pinned"])
	}
}

func TestPinSessionTurn_Unpin(t *testing.T) {
	var body map[string]interface{}
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})

	err := c.PinSessionTurn(context.Background(), "ses_1", mnemo.PinSessionTurnInput{
		TurnID: "turn_xyz",
		Pinned: false,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if body["pinned"] != false {
		t.Errorf("pinned: want false, got %v", body["pinned"])
	}
	if body["turnId"] != "turn_xyz" {
		t.Errorf("turnId: want %q, got %v", "turn_xyz", body["turnId"])
	}
}

func TestPinSessionTurn_404ErrorPropagated(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusNotFound, map[string]interface{}{
			"error": map[string]interface{}{
				"message": "session not found",
				"code":    "session_not_found",
			},
		})
	})

	err := c.PinSessionTurn(context.Background(), "ghost_ses", mnemo.PinSessionTurnInput{
		TurnID: "turn_1",
		Pinned: true,
	})
	if err == nil {
		t.Fatal("expected error for 404, got nil")
	}
}

func TestAppendTurn_401Propagated(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusUnauthorized, map[string]interface{}{
			"error": map[string]interface{}{"message": "unauthorized"},
		})
	})

	err := c.AppendTurn(context.Background(), "ses_1", mnemo.AppendTurnInput{
		Role:    "user",
		Content: "unauthorized",
	})
	if err == nil {
		t.Fatal("expected error for 401, got nil")
	}
}
