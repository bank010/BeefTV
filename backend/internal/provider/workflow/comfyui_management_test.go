package workflow

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestComfySavedWorkflowSeedControlsAndBypassedBranches(t *testing.T) {
	var saved map[string]any
	if err := json.Unmarshal([]byte(`{"nodes":[
		{"id":1,"type":"UNETLoader","inputs":[],"widgets_values":[]},
		{"id":2,"type":"LoraLoaderModelOnly","mode":4,"inputs":[{"name":"model","type":"MODEL","link":10}],"outputs":[{"type":"MODEL"}]},
		{"id":3,"type":"KSampler","inputs":[{"name":"model","link":11},{"name":"seed","widget":{}},{"name":"steps","widget":{}},{"name":"cfg","widget":{}},{"name":"sampler_name","widget":{}},{"name":"scheduler","widget":{}},{"name":"denoise","widget":{}}],"widgets_values":[123,"randomize",6,1,"res_multistep","beta",1]},
		{"id":4,"type":"PreviewAny","mode":4,"inputs":[]},
		{"id":5,"type":"TextGenerate","mode":2,"inputs":[]}
	],"links":[[10,1,0,2,0,"MODEL"],[11,2,0,3,0,"MODEL"]]}`), &saved); err != nil {
		t.Fatal(err)
	}
	for _, control := range []string{"fixed", "increment", "decrement", "randomize", ""} {
		t.Run(control, func(t *testing.T) {
			node := saved["nodes"].([]any)[2].(map[string]any)
			values := []any{float64(123), float64(6), float64(1), "res_multistep", "beta", float64(1)}
			if control != "" {
				values = append([]any{values[0], control}, values[1:]...)
			}
			node["widgets_values"] = values
			graph, err := comfySavedWorkflowToAPI(saved)
			if err != nil {
				t.Fatal(err)
			}
			if len(graph) != 2 || graph["2"] != nil || graph["4"] != nil || graph["5"] != nil {
				t.Fatalf("disabled nodes survived: %#v", graph)
			}
			inputs := graph["3"].(map[string]any)["inputs"].(map[string]any)
			if inputs["steps"] != float64(6) || inputs["cfg"] != float64(1) || inputs["sampler_name"] != "res_multistep" || inputs["scheduler"] != "beta" || inputs["denoise"] != float64(1) {
				t.Fatalf("shifted sampler inputs: %#v", inputs)
			}
			if inputs["model"].([]any)[0] != "1" {
				t.Fatalf("bypass not resolved: %#v", inputs["model"])
			}
		})
	}
}

func TestComfySavedWorkflowRejectsAmbiguousOrCyclicBypass(t *testing.T) {
	for _, ambiguous := range []bool{false, true} {
		var saved map[string]any
		_ = json.Unmarshal([]byte(`{"nodes":[
			{"id":1,"type":"CustomBypass","mode":4,"inputs":[{"name":"model","type":"MODEL","link":10}],"outputs":[{"type":"MODEL"}]},
			{"id":2,"type":"Sink","inputs":[{"name":"model","link":11}]}
		],"links":[[10,1,0,1,0,"MODEL"],[11,1,0,2,0,"MODEL"]]}`), &saved)
		if ambiguous {
			node := saved["nodes"].([]any)[0].(map[string]any)
			node["inputs"] = append(node["inputs"].([]any), map[string]any{"name": "other", "type": "MODEL", "link": float64(10)})
		}
		if _, err := comfySavedWorkflowToAPI(saved); err == nil {
			t.Fatalf("ambiguous=%v: unsafe bypass accepted", ambiguous)
		}
	}
}

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

func TestComfySavedWorkflowKeepsNodeTitleForFieldLabels(t *testing.T) {
	saved := map[string]any{
		"nodes": []any{
			map[string]any{
				"id": float64(1), "type": "CLIPTextEncode", "title": "正向提示词",
				"inputs":         []any{map[string]any{"name": "text", "link": nil, "widget": map[string]any{"name": "text"}}},
				"widgets_values": []any{"cat"},
			},
			map[string]any{
				"id": float64(2), "type": "KSampler", "title": "KSampler",
				"inputs":         []any{map[string]any{"name": "seed", "link": nil, "widget": map[string]any{"name": "seed"}}},
				"widgets_values": []any{float64(7)},
			},
		},
		"links": []any{},
	}

	converted, err := comfySavedWorkflowToAPI(saved)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := workflowFieldsFromManagement(converted, "image")
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Field{}
	for _, field := range fields {
		byName[field.NodeID+"::"+field.FieldName] = field
	}
	prompt := byName["1::text"]
	if prompt.Label != "正向提示词 · text" {
		t.Fatalf("label = %q, want node title in label", prompt.Label)
	}
	seed := byName["2::seed"]
	if strings.Contains(seed.Label, "<nil>") || seed.Label != "seed" {
		t.Fatalf("label = %q, want bare field name when title equals class_type", seed.Label)
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
