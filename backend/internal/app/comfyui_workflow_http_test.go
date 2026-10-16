package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/provider/workflow"
)

// 真实 HTTP 往返：验证出口策略、multipart 上传、/prompt 载荷、/history 轮询与 /view 下载。
func TestComfyUIWorkflowCompletesAgainstRealHTTPInstance(t *testing.T) {
	allowLoopbackProviderTest(t)
	var polls int32
	promptGraphs := make(chan map[string]any, 1)
	uploadedNames := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/upload/image":
			if got := r.Header.Get("Authorization"); got != "Bearer comfy-secret" {
				t.Errorf("upload Authorization = %q", got)
			}
			file, header, err := r.FormFile("image")
			if err != nil {
				t.Errorf("reference upload = %v", err)
				http.Error(w, "missing image part", http.StatusBadRequest)
				return
			}
			defer file.Close()
			raw, _ := io.ReadAll(file)
			if len(raw) == 0 || header.Size != int64(len(raw)) || r.FormValue("type") != "input" {
				t.Errorf("upload part = size %d bytes %d type %q", header.Size, len(raw), r.FormValue("type"))
			}
			uploadedNames <- "ref-" + header.Filename
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "ref-" + header.Filename, "subfolder": "input", "type": "input"})
		case r.Method == http.MethodPost && r.URL.Path == "/prompt":
			var payload struct {
				Prompt map[string]any `json:"prompt"`
			}
			body, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Errorf("prompt body = %s", body)
			}
			promptGraphs <- payload.Prompt
			_ = json.NewEncoder(w).Encode(map[string]any{"prompt_id": "p-1"})
		case r.Method == http.MethodGet && r.URL.Path == "/history/p-1":
			if atomic.AddInt32(&polls, 1) == 1 {
				_, _ = w.Write([]byte(`{}`))
				return
			}
			_, _ = w.Write([]byte(`{"p-1":{"status":{"status_str":"success","completed":true},"outputs":{"3":{"images":[{"filename":"out_00001_.png","subfolder":"","type":"output"}]}}}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/view":
			if r.URL.Query().Get("filename") != "out_00001_.png" {
				t.Errorf("view filename = %q", r.URL.Query().Get("filename"))
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("fake-png-bytes"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s, task := workflowPaidTaskFixture(t)
	ctx := withProviderAnalytics(context.Background(), s, task)
	input := canvasGenerationInput{
		Mode:   "image",
		Prompt: "雨夜街头的猫",
		Config: providerConfig{
			InterfaceType: string(model.ChannelInterfaceComfyUIImage),
			BaseURL:       server.URL,
			APIKey:        "comfy-secret",
			WorkflowJSON: map[string]interface{}{
				"1": map[string]interface{}{"class_type": "CLIPTextEncode", "inputs": map[string]interface{}{"text": "工作流默认提示词"}},
				"2": map[string]interface{}{"class_type": "LoadImage", "inputs": map[string]interface{}{"image": "工作流默认图片.png"}},
				"3": map[string]interface{}{"class_type": "SaveImage", "inputs": map[string]interface{}{"images": []interface{}{"2", float64(0)}}},
			},
			WorkflowFields: []workflow.Field{
				{ID: "1::text", NodeID: "1", FieldName: "text", Source: "prompt"},
				{ID: "2::image", NodeID: "2", FieldName: "image", Source: "reference_image"},
			},
		},
		ReferenceImages: []providerMedia{{ID: "ref-1", DataURL: "data:image/png;base64,AAAA"}},
	}

	result, err := s.runWorkflow(ctx, input)
	if err != nil {
		t.Fatalf("run = %v", err)
	}
	uploaded := <-uploadedNames
	prompt := <-promptGraphs
	nodeOne, _ := prompt["1"].(map[string]any)
	inputsOne, _ := nodeOne["inputs"].(map[string]any)
	if inputsOne["text"] != "雨夜街头的猫" {
		t.Fatalf("submitted prompt text = %#v", inputsOne["text"])
	}
	nodeTwo, _ := prompt["2"].(map[string]any)
	inputsTwo, _ := nodeTwo["inputs"].(map[string]any)
	if inputsTwo["image"] != uploaded {
		t.Fatalf("reference input = %#v, want uploaded name %q", inputsTwo["image"], uploaded)
	}
	nodeThree, _ := prompt["3"].(map[string]any)
	inputsThree, _ := nodeThree["inputs"].(map[string]any)
	if link, ok := inputsThree["images"].([]any); !ok || len(link) != 2 || fmt.Sprint(link[0]) != "2" {
		t.Fatalf("linked images input = %#v", inputsThree["images"])
	}
	if result["mode"] != "image" {
		t.Fatalf("result = %#v", result)
	}
	encoded, _ := json.Marshal(result)
	if !strings.Contains(string(encoded), "data:image/png;base64,") {
		t.Fatalf("result has no downloaded image: %s", encoded)
	}
	if polls != 2 {
		t.Fatalf("history polls = %d, want queued then completed", polls)
	}
	stored, err := s.repo.TaskForUser(task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ProviderRequestID != "p-1" || stored.PollStage != "succeeded" {
		t.Fatalf("task provider state = %q/%q, want p-1/succeeded", stored.ProviderRequestID, stored.PollStage)
	}
}

func TestComfyUIWorkflowManagementFetchConvertsSavedWorkflowOverHTTP(t *testing.T) {
	allowLoopbackProviderTest(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/userdata":
			if r.URL.Query().Get("dir") != "workflows" {
				t.Errorf("userdata dir = %q", r.URL.Query().Get("dir"))
			}
			_, _ = w.Write([]byte(`["雨夜猫.json"]`))
		case "/api/userdata/workflows/雨夜猫.json":
			_, _ = w.Write([]byte(`{"nodes":[{"id":1,"type":"TextEncode","inputs":[{"name":"text","link":null,"widget":{"name":"text"}}],"widgets_values":["默认"]},{"id":2,"type":"SaveImage","inputs":[{"name":"images","link":7}]}],"links":[[7,1,0,2,0,"IMAGE"]]}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	s := &Service{mode: serviceModeLocal}
	files, err := s.FetchComfyUIUserData(context.Background(), ComfyUIUserDataRequest{BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0]["name"] != "雨夜猫.json" {
		t.Fatalf("files = %#v", files)
	}
	fetched, err := s.FetchComfyUIWorkflow(context.Background(), ComfyUIUserDataRequest{BaseURL: server.URL, File: "workflows/雨夜猫.json", Capability: "image"})
	if err != nil {
		t.Fatal(err)
	}
	graph, _ := fetched["workflowJson"].(map[string]any)
	nodeTwo, _ := graph["2"].(map[string]any)
	inputs, _ := nodeTwo["inputs"].(map[string]any)
	if link, ok := inputs["images"].([]any); !ok || len(link) != 2 || fmt.Sprint(link[0]) != "1" {
		t.Fatalf("converted link = %#v", inputs["images"])
	}
	if fetched["title"] != "雨夜猫.json" && fetched["title"] != "雨夜猫" {
		t.Fatalf("title = %#v", fetched["title"])
	}
	if fetched["fields"] == nil {
		t.Fatalf("converted workflow has no field map: %#v", fetched)
	}
}
