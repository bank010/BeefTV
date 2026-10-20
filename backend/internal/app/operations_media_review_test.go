package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/operations"
)

func TestMediaReviewProviderSendsRealVideoOnceAndRejectsIncompleteResponses(t *testing.T) {
	for _, mode := range []string{"ok", "empty", "truncated", "http-error"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			media := base64.StdEncoding.EncodeToString([]byte("bounded-real-media-fixture"))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-key" || body["model"] != "wand-vega-vl-1.0-flash" || body["stream"] != false || body["tools"] != nil || body["thinking_enabled"] != false {
					t.Fatal("wrong isolated review contract")
				}
				messages := body["messages"].([]any)
				parts := messages[1].(map[string]any)["content"].([]any)
				if parts[0].(map[string]any)["video_url"].(map[string]any)["url"] != "data:video/mp4;base64,"+media {
					t.Fatal("video bytes lost")
				}
				if mode == "http-error" {
					w.WriteHeader(502)
					w.Write([]byte("sensitive upstream failure"))
					return
				}
				text, finish := "observed two objects", "stop"
				if mode == "empty" {
					text = ""
				}
				if mode == "truncated" {
					finish = "length"
				}
				json.NewEncoder(w).Encode(map[string]any{"id": "req-1", "model": "wand-vega-vl-1.0-flash", "usage": map[string]int{"prompt_tokens": 123, "completion_tokens": 24}, "choices": []any{map[string]any{"message": map[string]string{"content": text}, "finish_reason": finish}}})
			}))
			defer server.Close()
			result, err := reviewMediaWithProvider(context.Background(), AssistantProvider{BaseURL: server.URL + "/v1", APIKey: "fixture-key", Model: "wand-vega-vl-1.0-flash"}, operations.MediaPart{MimeType: "video/mp4", Data: media}, "观察物体数量")
			if calls != 1 {
				t.Fatalf("inference retried %d times", calls)
			}
			if mode == "ok" {
				if err != nil || result.RequestID != "req-1" || result.Text != "observed two objects" || len(result.Usage) == 0 {
					t.Fatalf("missing observation %+v %v", result, err)
				}
			} else if err == nil || strings.Contains(err.Error(), "sensitive") {
				t.Fatalf("invalid completion accepted/leaked: %v", err)
			}
		})
	}
}
