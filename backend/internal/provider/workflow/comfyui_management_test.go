package workflow

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

func TestFetchComfyUIUserDataMapsPathList(t *testing.T) {
	executor := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.Method != "GET" {
			t.Fatalf("request method = %q", req.Method)
		}
		if !strings.Contains(req.URL, "/api/userdata?dir=workflows%2Fvideo") {
			t.Fatalf("request URL = %q", req.URL)
		}
		return []byte(`["sample.json","nested/other.json"]`), "application/json", nil
	}}
	client := &Client{Requests: executor}

	files, err := client.FetchComfyUIUserData(context.Background(), Config{BaseURL: "https://comfy.example"}, "workflows/video")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || files[0]["name"] != "sample.json" || files[0]["type"] != "file" || files[1]["name"] != "nested/other.json" {
		t.Fatalf("files = %#v", files)
	}
}

func TestFetchComfyUIWorkflowEscapesNestedPathAsSingleRouteParameter(t *testing.T) {
	const workflowPath = "workflows/video/深度动作捕捉.json"
	executor := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if !strings.Contains(req.URL, "/api/userdata/"+url.PathEscape(workflowPath)) {
			t.Fatalf("request URL = %q", req.URL)
		}
		return []byte(`{"1":{"class_type":"SaveImage","inputs":{"images":["2",0]}}}`), "application/json", nil
	}}
	client := &Client{Requests: executor}

	workflow, err := client.FetchComfyUIWorkflow(context.Background(), Config{BaseURL: "https://comfy.example"}, workflowPath)
	if err != nil {
		t.Fatal(err)
	}
	if workflow["workflowJson"] == nil {
		t.Fatalf("workflow = %#v", workflow)
	}
}

func TestComfySavedWorkflowConvertsToPromptGraph(t *testing.T) {
	saved := map[string]any{
		"nodes": []any{
			map[string]any{
				"id": float64(1), "type": "TextSource",
				"inputs":         []any{map[string]any{"name": "text", "link": nil, "widget": map[string]any{"name": "text"}}},
				"widgets_values": []any{"hello"},
			},
			map[string]any{
				"id": float64(2), "type": "TextSink",
				"inputs":         []any{map[string]any{"name": "text", "link": float64(5)}},
				"widgets_values": []any{},
			},
		},
		"links": []any{[]any{float64(5), float64(1), float64(0), float64(2), float64(0), "STRING"}},
	}

	converted, err := comfySavedWorkflowToAPI(saved)
	if err != nil {
		t.Fatal(err)
	}
	source, _ := converted["1"].(map[string]any)
	sourceInputs, _ := source["inputs"].(map[string]any)
	if source["class_type"] != "TextSource" || sourceInputs["text"] != "hello" {
		t.Fatalf("source node = %#v", source)
	}
	sink, _ := converted["2"].(map[string]any)
	sinkInputs, _ := sink["inputs"].(map[string]any)
	link, _ := sinkInputs["text"].([]any)
	if len(link) != 2 || link[0] != "1" || link[1] != float64(0) {
		t.Fatalf("sink link = %#v", sinkInputs["text"])
	}
}

func TestCleanComfyWorkflowPathRejectsTraversal(t *testing.T) {
	for _, value := range []string{"../secret.json", "workflows/../secret.json", "/workflows/a.json", "workflows/a.json?x=1", "output/a.json"} {
		if _, err := cleanComfyWorkflowPath(value, true); err == nil {
			t.Errorf("cleanComfyWorkflowPath(%q) unexpectedly succeeded", value)
		}
	}
	if got, err := cleanComfyWorkflowPath("workflows/video/example.json", true); err != nil || got != "workflows/video/example.json" {
		t.Fatalf("cleanComfyWorkflowPath valid = %q, %v", got, err)
	}
}
