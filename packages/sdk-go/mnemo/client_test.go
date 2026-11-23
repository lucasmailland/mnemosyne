package mnemo_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/lucasmailland/mnemosyne/packages/sdk-go/mnemo"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type handler func(w http.ResponseWriter, r *http.Request)

func testServer(t *testing.T, h handler) (*httptest.Server, *mnemo.Client) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(h))
	t.Cleanup(srv.Close)
	c, err := mnemo.NewClient(srv.URL, "test-api-key")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return srv, c
}

func jsonResponse(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

func TestNewClient_Validation(t *testing.T) {
	_, err := mnemo.NewClient("", "key")
	if err == nil {
		t.Error("expected error for empty baseURL, got nil")
	}
	_, err = mnemo.NewClient("http://localhost", "")
	if err == nil {
		t.Error("expected error for empty apiKey, got nil")
	}
	c, err := mnemo.NewClient("http://localhost", "key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c == nil {
		t.Error("expected non-nil Client")
	}
}

// ---------------------------------------------------------------------------
// Authorization header
// ---------------------------------------------------------------------------

func TestRecall_SendsAuthHeader(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-api-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{"hits": []interface{}{}, "debug": map[string]interface{}{}})
	})
	_, err := c.Recall(context.Background(), mnemo.RecallInput{Query: "q"})
	if err != nil {
		t.Fatalf("Recall: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

func TestRecall_HappyPath(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/recall" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["query"] != "hello world" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"hits": []interface{}{
				map[string]interface{}{"id": "f1", "content": "hello", "score": 0.91},
			},
			"debug": map[string]interface{}{},
		})
	})
	resp, err := c.Recall(context.Background(), mnemo.RecallInput{Query: "hello world", TopK: 5})
	if err != nil {
		t.Fatalf("Recall: %v", err)
	}
	if len(resp.Hits) != 1 {
		t.Fatalf("expected 1 hit, got %d", len(resp.Hits))
	}
	if resp.Hits[0]["id"] != "f1" {
		t.Errorf("expected hit id 'f1', got %v", resp.Hits[0]["id"])
	}
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

func TestAPIError_4xx(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusUnauthorized, map[string]interface{}{
			"error": map[string]interface{}{
				"message": "unauthorized",
				"code":    "ERR_AUTH",
			},
		})
	})
	_, err := c.Recall(context.Background(), mnemo.RecallInput{Query: "q"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	apiErr, ok := err.(*mnemo.APIError)
	if !ok {
		t.Fatalf("expected *mnemo.APIError, got %T: %v", err, err)
	}
	if apiErr.Status != http.StatusUnauthorized {
		t.Errorf("expected status 401, got %d", apiErr.Status)
	}
	if apiErr.Code != "ERR_AUTH" {
		t.Errorf("expected code ERR_AUTH, got %q", apiErr.Code)
	}
	if !strings.Contains(apiErr.Message, "unauthorized") {
		t.Errorf("expected message to contain 'unauthorized', got %q", apiErr.Message)
	}
}

func TestAPIError_5xx(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("internal error"))
	})
	_, err := c.Recall(context.Background(), mnemo.RecallInput{Query: "q"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	apiErr, ok := err.(*mnemo.APIError)
	if !ok {
		t.Fatalf("expected *mnemo.APIError, got %T", err)
	}
	if apiErr.Status != 500 {
		t.Errorf("expected status 500, got %d", apiErr.Status)
	}
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

func TestCreateFact(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/remember" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["statement"] != "hello fact" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		jsonResponse(w, http.StatusCreated, map[string]interface{}{"id": "fact-1", "statement": "hello fact"})
	})
	result, err := c.CreateFact(context.Background(), mnemo.FactInput{Content: "hello fact"})
	if err != nil {
		t.Fatalf("CreateFact: %v", err)
	}
	if result["id"] != "fact-1" {
		t.Errorf("expected id 'fact-1', got %v", result["id"])
	}
	if result["content"] != "hello fact" {
		t.Errorf("expected content remapped from statement, got %v", result["content"])
	}
}

func TestGetFact(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/facts/f-99" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{"id": "f-99"})
	})
	result, err := c.GetFact(context.Background(), "f-99")
	if err != nil {
		t.Fatalf("GetFact: %v", err)
	}
	if result["id"] != "f-99" {
		t.Errorf("expected id 'f-99', got %v", result["id"])
	}
}

func TestForgetFact_Returns204(t *testing.T) {
	called := false
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && r.URL.Path == "/facts/f1" {
			called = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	err := c.ForgetFact(context.Background(), "f1")
	if err != nil {
		t.Fatalf("ForgetFact: %v", err)
	}
	if !called {
		t.Error("expected DELETE /facts/f1 to be called")
	}
}

func TestPinFact_SendsPinnedTrue(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		pinned, ok := body["pinned"].(bool)
		if !ok || !pinned {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{"id": "f1", "pinned": true})
	})
	result, err := c.PinFact(context.Background(), "f1")
	if err != nil {
		t.Fatalf("PinFact: %v", err)
	}
	if result["pinned"] != true {
		t.Errorf("expected pinned=true in response")
	}
}

func TestUnpinFact_SendsPinnedFalse(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		pinned, ok := body["pinned"].(bool)
		if !ok || pinned {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{"id": "f1", "pinned": false})
	})
	result, err := c.UnpinFact(context.Background(), "f1")
	if err != nil {
		t.Fatalf("UnpinFact: %v", err)
	}
	if result["pinned"] != false {
		t.Errorf("expected pinned=false in response")
	}
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

func TestHealth(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{"status": "ok"})
	})
	result, err := c.Health(context.Background())
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if result["status"] != "ok" {
		t.Errorf("expected status 'ok', got %v", result["status"])
	}
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

func TestListTasks_WithStatusFilter(t *testing.T) {
	var seenQuery url.Values
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		seenQuery = r.URL.Query()
		jsonResponse(w, http.StatusOK, map[string]interface{}{"items": []interface{}{}, "total": 0})
	})
	params := url.Values{}
	params.Set("status", "pending")
	_, err := c.ListTasks(context.Background(), params)
	if err != nil {
		t.Fatalf("ListTasks: %v", err)
	}
	if seenQuery.Get("status") != "pending" {
		t.Errorf("expected status=pending in query, got %q", seenQuery.Get("status"))
	}
}

func TestCreateTask(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		jsonResponse(w, http.StatusCreated, map[string]interface{}{"id": "task-1", "title": body["title"]})
	})
	result, err := c.CreateTask(context.Background(), map[string]interface{}{"title": "Ship Go SDK"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if result["title"] != "Ship Go SDK" {
		t.Errorf("expected title 'Ship Go SDK', got %v", result["title"])
	}
}

func TestArchiveTask_SendsDelete(t *testing.T) {
	called := false
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			called = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	err := c.ArchiveTask(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("ArchiveTask: %v", err)
	}
	if !called {
		t.Error("expected DELETE to be called")
	}
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

func TestListFederationPeers(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/memory/federation/peers" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{"peers": []interface{}{}})
	})
	result, err := c.ListFederationPeers(context.Background())
	if err != nil {
		t.Fatalf("ListFederationPeers: %v", err)
	}
	peers, ok := result["peers"].([]interface{})
	if !ok {
		t.Fatal("expected peers to be a slice")
	}
	if len(peers) != 0 {
		t.Errorf("expected 0 peers, got %d", len(peers))
	}
}

func TestListPendingFederationPeers(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/memory/federation/peers/pending" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"peers":     []interface{}{},
			"discovery": map[string]interface{}{"enabled": true, "reason": "auto"},
		})
	})
	result, err := c.ListPendingFederationPeers(context.Background())
	if err != nil {
		t.Fatalf("ListPendingFederationPeers: %v", err)
	}
	discovery, ok := result["discovery"].(map[string]interface{})
	if !ok {
		t.Fatal("expected discovery field")
	}
	if discovery["enabled"] != true {
		t.Errorf("expected discovery.enabled=true, got %v", discovery["enabled"])
	}
}

func TestTriggerFederationSync(t *testing.T) {
	var seenBody map[string]interface{}
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/memory/federation/sync" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&seenBody)
		jsonResponse(w, http.StatusAccepted, map[string]interface{}{"jobId": "job-1", "status": "pending"})
	})
	result, err := c.TriggerFederationSync(context.Background(), "peer-1")
	if err != nil {
		t.Fatalf("TriggerFederationSync: %v", err)
	}
	if result["jobId"] != "job-1" {
		t.Errorf("expected jobId 'job-1', got %v", result["jobId"])
	}
	if seenBody["peerId"] != "peer-1" {
		t.Errorf("expected peerId 'peer-1' in request body, got %v", seenBody["peerId"])
	}
}

func TestDeleteFederationPeer(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/memory/federation/peers/p-1" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{"deleted": true, "peerId": "p-1"})
	})
	result, err := c.DeleteFederationPeer(context.Background(), "p-1")
	if err != nil {
		t.Fatalf("DeleteFederationPeer: %v", err)
	}
	if result["deleted"] != true {
		t.Errorf("expected deleted=true, got %v", result["deleted"])
	}
}

func TestResolveFederationConflict(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, ok := body["itemA"]; !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"winner":     map[string]interface{}{"id": "f1"},
			"strategy":   "trust_anchor",
			"resolvedAt": "2026-06-17T00:00:00Z",
		})
	})
	result, err := c.ResolveFederationConflict(context.Background(), map[string]interface{}{
		"itemA": map[string]interface{}{"id": "f1", "content": "a", "version": 2},
		"itemB": map[string]interface{}{"id": "f1", "content": "b", "version": 1},
	})
	if err != nil {
		t.Fatalf("ResolveFederationConflict: %v", err)
	}
	if result["strategy"] != "trust_anchor" {
		t.Errorf("expected strategy 'trust_anchor', got %v", result["strategy"])
	}
}

// ---------------------------------------------------------------------------
// Anticipation
// ---------------------------------------------------------------------------

func TestGetAnticipationFeed(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"items": []interface{}{
				map[string]interface{}{"factId": "f1", "score": 0.9, "source": "sequential"},
			},
			"generatedAt": "2026-06-17T00:00:00Z",
		})
	})
	params := url.Values{}
	params.Set("limit", "5")
	result, err := c.GetAnticipationFeed(context.Background(), params)
	if err != nil {
		t.Fatalf("GetAnticipationFeed: %v", err)
	}
	items, ok := result["items"].([]interface{})
	if !ok || len(items) == 0 {
		t.Fatal("expected at least one item")
	}
}

// ---------------------------------------------------------------------------
// Self-edit
// ---------------------------------------------------------------------------

func TestSelfEdit(t *testing.T) {
	var seenBody map[string]interface{}
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&seenBody)
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"action":    "strengthen",
			"target":    "f1",
			"applied":   true,
			"appliedAt": "2026-06-17T00:00:00Z",
		})
	})
	result, err := c.SelfEdit(context.Background(), mnemo.SelfEditInput{
		Action: "strengthen", Target: "f1", Reason: "boost",
	})
	if err != nil {
		t.Fatalf("SelfEdit: %v", err)
	}
	if result["applied"] != true {
		t.Errorf("expected applied=true, got %v", result["applied"])
	}
	if seenBody["action"] != "strengthen" {
		t.Errorf("expected action='strengthen' in body, got %v", seenBody["action"])
	}
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

func TestDryRunComposition(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"inferences": []interface{}{
				map[string]interface{}{"id": "inf-1", "content": "derived", "confidence": 0.7},
			},
		})
	})
	result, err := c.DryRunComposition(context.Background(), map[string]interface{}{"factIds": []string{"f1", "f2"}})
	if err != nil {
		t.Fatalf("DryRunComposition: %v", err)
	}
	inferences, ok := result["inferences"].([]interface{})
	if !ok || len(inferences) == 0 {
		t.Fatal("expected at least one inference")
	}
}
