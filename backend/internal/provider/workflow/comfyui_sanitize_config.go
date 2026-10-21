package workflow

import (
	"bytes"
	"encoding/json"
	"reflect"
)

// SanitizeComfyWorkflowsInModelConfig strips ComfyUI-invalid model path prefixes
// from comfyUI.workflows[].workflowJson snapshots. Returns true when any workflow changed.
func SanitizeComfyWorkflowsInModelConfig(config map[string]any) bool {
	if config == nil {
		return false
	}
	comfyUI, _ := config["comfyUI"].(map[string]any)
	if comfyUI == nil {
		return false
	}
	workflows, _ := comfyUI["workflows"].([]any)
	if len(workflows) == 0 {
		return false
	}
	changed := false
	for _, item := range workflows {
		wf, _ := item.(map[string]any)
		if wf == nil {
			continue
		}
		raw, _ := wf["workflowJson"].(map[string]any)
		if raw == nil {
			continue
		}
		sanitized, err := cloneComfyWorkflow(raw)
		if err != nil {
			before, _ := json.Marshal(raw)
			normalizeComfyListedModelNames(raw)
			after, _ := json.Marshal(raw)
			if !bytes.Equal(before, after) {
				changed = true
			}
			continue
		}
		if !reflect.DeepEqual(raw, sanitized) {
			wf["workflowJson"] = sanitized
			changed = true
		}
	}
	return changed
}
