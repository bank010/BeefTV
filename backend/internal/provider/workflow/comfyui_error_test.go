package workflow

import (
	"strings"
	"testing"
)

func TestComfyInvalidOptionSummaryExplainsDeletedLoRA(t *testing.T) {
	summary := comfyInvalidOptionSummary("lora_name", "NSFW Qwen by TheseAlpacas V2.safetensors", "value 'NSFW Qwen by TheseAlpacas V2.safetensors' not in ['available.safetensors']")
	if !strings.Contains(summary, "LoRA 模型不可用，可能已被删除") {
		t.Fatalf("summary = %q", summary)
	}
	if !strings.Contains(summary, "NSFW Qwen by TheseAlpacas V2.safetensors") {
		t.Fatalf("summary should include the safe filename: %q", summary)
	}
}

func TestComfyExecutionFailureSummaryExplainsDeletedLoRA(t *testing.T) {
	summary := comfyExecutionFailureSummary([]any{
		[]any{"execution_error", map[string]any{"exception_type": "RuntimeError", "exception_message": "No LoRA named NSFW Qwen by TheseAlpacas V2.safetensors found"}},
	})
	if !strings.Contains(summary, "LoRA 模型不可用，可能已被删除") {
		t.Fatalf("summary = %q", summary)
	}
}

func TestComfyNodeErrorsBypassableLoRAOnly(t *testing.T) {
	if comfyNodeErrorsBypassableLoRAOnly(map[string]any{
		"lora": map[string]any{
			"class_type": "LoraLoader",
			"errors":     []any{map[string]any{"type": "value_not_in_list", "extra_info": map[string]any{"input_name": "lora_name"}}},
		},
	}) != true {
		t.Fatal("expected bypassable LoRA-only node_errors")
	}
	if comfyNodeErrorsBypassableLoRAOnly(map[string]any{
		"512": map[string]any{
			"class_type": "KSampler",
			"errors":     []any{map[string]any{"type": "value_not_in_list", "extra_info": map[string]any{"input_name": "sampler_name"}}},
		},
	}) {
		t.Fatal("non-LoRA node_errors must not bypass")
	}
}

func TestNormalizeComfyCLIPModelFilenameStripsTextEncodersPrefix(t *testing.T) {
	cases := map[string]string{
		"text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
		"models/text_encoders/qwen3vl_4b_bf16.safetensors":              "qwen3vl_4b_bf16.safetensors",
		"qwen3vl_8b_bf16.safetensors":                                   "qwen3vl_8b_bf16.safetensors",
		"./text_encoders/foo.safetensors":                               "foo.safetensors",
	}
	for input, want := range cases {
		if got := normalizeComfyListedModelFilename(input); got != want {
			t.Fatalf("%q => %q, want %q", input, got, want)
		}
	}
}

func TestNormalizeComfyCLIPLoaderNamesMutatesGraph(t *testing.T) {
	graph := map[string]interface{}{
		"128": map[string]interface{}{
			"class_type": "CLIPLoader",
			"inputs": map[string]interface{}{
				"clip_name": "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
			},
		},
		"dual": map[string]interface{}{
			"class_type": "DualCLIPLoader",
			"inputs": map[string]interface{}{
				"clip_name1": "text_encoders/qwen3vl_4b_bf16.safetensors",
				"clip_name2": "qwen3vl_8b_bf16.safetensors",
			},
		},
	}
	normalizeComfyListedModelNames(graph)
	inputs := graph["128"].(map[string]interface{})["inputs"].(map[string]interface{})
	if inputs["clip_name"] != "qwen3vl_32b_minimax_h3_int8_convrot.safetensors" {
		t.Fatalf("clip_name = %#v", inputs["clip_name"])
	}
	dualInputs := graph["dual"].(map[string]interface{})["inputs"].(map[string]interface{})
	if dualInputs["clip_name1"] != "qwen3vl_4b_bf16.safetensors" {
		t.Fatalf("clip_name1 = %#v", dualInputs["clip_name1"])
	}
}

func TestComfyNodeErrorsFixableCLIPPath(t *testing.T) {
	nodeErrors := map[string]any{
		"128": map[string]any{
			"class_type": "CLIPLoader",
			"errors": []any{
				map[string]any{
					"type": "value_not_in_list",
					"extra_info": map[string]any{
						"input_name":     "clip_name",
						"received_value": "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
					},
				},
			},
		},
	}
	if !comfyNodeErrorsFixableListedModelPath(nodeErrors) {
		t.Fatal("expected fixable CLIP path validation error")
	}
	if comfyNodeErrorsFixableListedModelPath(map[string]any{
		"512": map[string]any{
			"class_type": "KSampler",
			"errors": []any{map[string]any{
				"type":       "value_not_in_list",
				"extra_info": map[string]any{"input_name": "sampler_name"},
			}},
		},
	}) {
		t.Fatal("non-clip errors must not be fixable")
	}
}

func TestBypassRejectedComfyLoRAsReconnectsModelAndClip(t *testing.T) {
	graph := map[string]interface{}{
		"base": map[string]interface{}{"class_type": "CheckpointLoader", "inputs": map[string]interface{}{}},
		"lora": map[string]interface{}{
			"class_type": "LoraLoader",
			"inputs": map[string]interface{}{
				"model":     []interface{}{"base", float64(0)},
				"clip":      []interface{}{"base", float64(1)},
				"lora_name": "NSFW Qwen by TheseAlpacas V2.safetensors",
			},
		},
		"sampler": map[string]interface{}{"class_type": "KSampler", "inputs": map[string]interface{}{"model": []interface{}{"lora", float64(0)}, "clip": []interface{}{"lora", float64(1)}}},
	}

	bypassed, err := bypassRejectedComfyLoRAs(graph, map[string]bool{"lora": true})
	if err != nil || !bypassed {
		t.Fatalf("bypassed=%v err=%v", bypassed, err)
	}
	if graph["lora"] != nil {
		t.Fatalf("stale lora node survived: %#v", graph)
	}
	inputs := graph["sampler"].(map[string]interface{})["inputs"].(map[string]interface{})
	if got := inputs["model"]; got == nil || got.([]interface{})[0] != "base" || got.([]interface{})[1] != float64(0) {
		t.Fatalf("model link = %#v", got)
	}
	if got := inputs["clip"]; got == nil || got.([]interface{})[0] != "base" || got.([]interface{})[1] != float64(1) {
		t.Fatalf("clip link = %#v", got)
	}
}
