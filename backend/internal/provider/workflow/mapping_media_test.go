package workflow

import (
	"strings"
	"testing"
)

func TestEnsureWorkflowFieldsForMediaInputsInfersEmptyVideoWidget(t *testing.T) {
	graph := map[string]interface{}{
		"10": map[string]interface{}{
			"class_type": "VHS_LoadVideo",
			"inputs": map[string]interface{}{
				"video": "",
			},
		},
	}
	saved := []Field{{NodeID: "10", FieldName: "video", FieldType: "TEXT", Source: "", Enabled: boolPtr(true)}}
	input := Input{Mode: "video", ReferenceVideos: []Media{{ID: "v1", URL: "https://example.com/a.mp4"}}}
	fields, err := ensureWorkflowFieldsForMediaInputs(saved, graph, "video", input)
	if err != nil {
		t.Fatalf("ensureWorkflowFieldsForMediaInputs() err = %v", err)
	}
	if err := validateWorkflowMediaInputs(fields, input); err != nil {
		t.Fatalf("validate after ensure: %v", err)
	}
}

func TestEnsureWorkflowFieldsForMediaInputsInfersVideoSlotsFromGraph(t *testing.T) {
	graph := map[string]interface{}{
		"10": map[string]interface{}{
			"class_type": "VHS_LoadVideo",
			"inputs": map[string]interface{}{
				"video": "sample.mp4",
			},
		},
	}
	saved := []Field{{NodeID: "1", FieldName: "prompt", Source: "prompt", Enabled: boolPtr(true)}}
	input := Input{
		Mode: "video",
		ReferenceVideos: []Media{
			{ID: "v1", URL: "https://example.com/a.mp4"},
		},
	}
	fields, err := ensureWorkflowFieldsForMediaInputs(saved, graph, "video", input)
	if err != nil {
		t.Fatalf("ensureWorkflowFieldsForMediaInputs() err = %v", err)
	}
	if err := validateWorkflowMediaInputs(fields, input); err != nil {
		t.Fatalf("validate after ensure: %v", err)
	}
	hasVideo := false
	for _, field := range fields {
		if isWorkflowMediaReferenceSource(field.Source) && strings.Contains(strings.ToLower(field.Source), "video") {
			hasVideo = true
		}
	}
	if !hasVideo {
		t.Fatalf("fields = %#v", fields)
	}
}

func boolPtr(value bool) *bool { return &value }
