package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

func TestWorkspaceModelConfigReturnsBuiltinBeefAPIAndPersistenceMetadata(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	data := modelConfigResponseData(t, recorder)
	if data["health"] != string(workspace.ConfigHealthDefault) || data["revision"] != float64(0) || data["source"] != "builtin+local" {
		t.Fatalf("missing persistence metadata: %#v", data)
	}
	config, _ := data["config"].(map[string]any)
	channels, _ := config["channels"].([]any)
	if len(channels) != 1 || channels[0].(map[string]any)["id"] != "beefapi" {
		t.Fatalf("builtin BeefAPI missing: %#v", channels)
	}
	if models, _ := channels[0].(map[string]any)["models"].([]any); len(models) != 0 {
		t.Fatalf("model catalog must remain dynamic: %#v", models)
	}
}

func TestWorkspaceModelConfigGETRedactsBeefAPIKey(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	first := putModelConfig(t, router, 0, "local-secret-key")
	if first.Code != http.StatusOK {
		t.Fatalf("put status = %d body=%s", first.Code, first.Body.String())
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if bytes.Contains(recorder.Body.Bytes(), []byte("local-secret-key")) {
		t.Fatalf("model-config leaked api key: %s", recorder.Body.String())
	}
	stale := putModelConfig(t, router, 1, "ui-overwrite")
	if stale.Code != http.StatusOK {
		t.Fatalf("second put status = %d body=%s", stale.Code, stale.Body.String())
	}
}

func TestWorkspaceModelConfigRejectsStaleRevisionWithoutLeakingSecrets(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	first := putModelConfig(t, router, 0, "first-secret")
	if first.Code != http.StatusOK {
		t.Fatalf("first put status = %d body=%s", first.Code, first.Body.String())
	}
	if revision := modelConfigResponseData(t, first)["revision"]; revision != float64(1) {
		t.Fatalf("committed revision = %#v", revision)
	}

	stale := putModelConfig(t, router, 0, "must-not-leak")
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale put status = %d body=%s", stale.Code, stale.Body.String())
	}
	if bytes.Contains(stale.Body.Bytes(), []byte("must-not-leak")) || bytes.Contains(stale.Body.Bytes(), []byte("first-secret")) {
		t.Fatalf("error response leaked a secret: %s", stale.Body.String())
	}
}

func TestWorkspaceModelConfigReturnsBadRequestForInvalidProviderIdentitiesAndSecrets(t *testing.T) {
	tests := []struct {
		name   string
		config map[string]any
	}{
		{
			name: "duplicate channel IDs",
			config: map[string]any{"channels": []any{
				map[string]any{"id": "duplicate"},
				map[string]any{"id": "duplicate"},
			}},
		},
		{
			name: "unmatched redacted secret",
			config: map[string]any{"channels": []any{
				map[string]any{"id": "custom", "apiKey": workspace.RedactedSecret},
			}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router, _ := newModelConfigTestRouter(t)
			body, err := json.Marshal(map[string]any{"expectedRevision": 0, "config": test.config})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("put status = %d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestWorkspaceModelConfigSavesComfyUIWithNumericNodeIDs(t *testing.T) {
	router, store := newModelConfigTestRouter(t)
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"custom","apiKey":"kept-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(`{
		"channels":[{"id":"custom"}],
		"comfyUI":{"enabled":true,"workflows":[{
			"workflowId":"workflows/example.json","title":"Example","capability":"image",
			"workflowJson":{"12":{"class_type":"CLIPTextEncode","inputs":{"text":"example"}}},
			"sourceWorkflowJson":{"nodes":[{"id":12,"type":"CLIPTextEncode"},{"id":23,"type":"SaveImage"}]}
		}]}
	}`), &config); err != nil {
		t.Fatal(err)
	}
	config["channels"].([]any)[0].(map[string]any)["apiKey"] = workspace.RedactedSecret
	wantWorkflow, err := json.Marshal(config["comfyUI"])
	if err != nil {
		t.Fatal(err)
	}
	for _, revision := range []int64{1, 2} {
		body, err := json.Marshal(map[string]any{"expectedRevision": revision, "config": config})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("workflow save status = %d", response.Code)
		}
		data := modelConfigResponseData(t, response)
		if data["saved"] != true || data["revision"] != float64(revision+1) {
			t.Fatal("workflow save was not confirmed with an advanced revision")
		}
		loaded := httptest.NewRecorder()
		router.ServeHTTP(loaded, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
		if loaded.Code != http.StatusOK {
			t.Fatalf("workflow reload status = %d", loaded.Code)
		}
		config = modelConfigResponseData(t, loaded)["config"].(map[string]any)
		gotWorkflow, err := json.Marshal(config["comfyUI"])
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(gotWorkflow, wantWorkflow) {
			t.Fatal("workflow changed after HTTP save and reload")
		}
	}
	raw, err := store.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("kept-secret")) {
		t.Fatal("workflow save lost the existing channel credential")
	}
}

func newModelConfigTestRouter(t *testing.T) (*gin.Engine, *workspace.ProviderConfig) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(nil, dir)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{ProviderConfig: store}))
	RegisterWorkspaceRoutes(router.Group("/api"), service)
	return router, store
}

func putModelConfig(t *testing.T, router *gin.Engine, expectedRevision int64, apiKey string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"expectedRevision": expectedRevision,
		"config":           map[string]any{"channels": []any{map[string]any{"id": "beefapi", "apiKey": apiKey, "enabled": true}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	return recorder
}

func modelConfigResponseData(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}
