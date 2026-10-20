package workflow

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func videoControlGraph(t *testing.T) map[string]any {
	t.Helper()
	var graph map[string]any
	if err := json.Unmarshal([]byte(`{
		"size":{"class_type":"ResolutionSelector","inputs":{"aspect_ratio":"9:16 (Portrait Widescreen)","megapixels":0.9,"multiple":32}},
		"seconds":{"class_type":"PrimitiveFloat","inputs":{"value":15}},
		"strength":{"class_type":"PrimitiveFloat","inputs":{"value":0.5}},
		"frames":{"class_type":"ComfyMathExpression","inputs":{"values.a":["seconds",0],"expression":"max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17"}},
		"video":{"class_type":"MiniMaxH3ReferenceToVideo","inputs":{"width":["size",0],"height":["size",1],"length":["frames",1]}},
		"output":{"class_type":"VHS_VideoCombine","inputs":{"frame_rate":24,"crf":19,"save_output":true}}
	}`), &graph); err != nil {
		t.Fatal(err)
	}
	return graph
}

func TestComfyVideoControlsInferAndApply(t *testing.T) {
	graph := videoControlGraph(t)
	data, err := json.Marshal(CollectFields(graph, "video"))
	if err != nil {
		t.Fatal(err)
	}
	var fields []Field
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range fields {
		switch field.NodeID + "::" + field.FieldName {
		case "size::aspect_ratio":
			if field.Source != "aspectRatio" || len(field.Options) != 8 {
				t.Fatalf("ratio contract: %+v", field)
			}
		case "size::megapixels":
			if field.Source != "vquality" || field.Min != 0.1 || field.Max != float64(16) {
				t.Fatalf("resolution contract: %+v", field)
			}
		case "seconds::value":
			if field.Source != "videoSeconds" || field.Max != float64(15) {
				t.Fatalf("duration contract: %+v", field)
			}
		}
	}
	input := Input{Mode: "video", Config: Config{Size: "16:9 (Widescreen)", VQuality: "1.2", VideoSeconds: "8"}}
	if err := applyComfyWorkflowFields(graph, workflowFieldsForMode(fields, "video"), nil, input); err != nil {
		t.Fatal(err)
	}
	expected := videoControlGraph(t)
	expected["size"].(map[string]any)["inputs"].(map[string]any)["aspect_ratio"] = "16:9 (Widescreen)"
	actualMP := graph["size"].(map[string]any)["inputs"].(map[string]any)["megapixels"]
	mp, ok := actualMP.(float64)
	if !ok || math.Abs(mp-1.2) > 1e-9 {
		t.Fatalf("megapixels must be numeric: %#v", actualMP)
	}
	expected["size"].(map[string]any)["inputs"].(map[string]any)["megapixels"] = mp
	expected["seconds"].(map[string]any)["inputs"].(map[string]any)["value"] = int64(8)
	if !reflect.DeepEqual(graph, expected) {
		t.Fatalf("unrelated values or links changed: %#v", graph)
	}
	// Explicitly disabled mappings are respected on submission.
	for i := range fields {
		disabled := false
		fields[i].Enabled = &disabled
	}
	unchanged := videoControlGraph(t)
	if err := applyComfyWorkflowFields(unchanged, fields, nil, input); err != nil || !reflect.DeepEqual(unchanged, videoControlGraph(t)) {
		t.Fatalf("disabled mappings changed graph: %v", err)
	}
}

func TestComfyVideoControlsDoNotGuessOtherTopologies(t *testing.T) {
	graph := videoControlGraph(t)
	graph["frames"].(map[string]any)["inputs"].(map[string]any)["expression"] = "a * 30"
	graph["video"].(map[string]any)["inputs"].(map[string]any)["height"] = []any{"size", 0}
	for _, field := range CollectFields(graph, "video") {
		if field["nodeId"] == "seconds" || field["nodeId"] == "strength" || field["fieldName"] == "megapixels" {
			if field["enabled"] != false || field["source"] != "" {
				t.Fatalf("guessed unrelated control: %+v", field)
			}
		}
	}
}
