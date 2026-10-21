package workflow

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

// 本机 ComfyUI 只有在部署者精确允许后才算合法出口，测试走同一条策略。
func allowLocalComfyUI(t *testing.T) string {
	t.Helper()
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "localhost")
	return "http://localhost:8188"
}

type wakeImmediately struct{ DefaultTimePolicy }

func (wakeImmediately) Sleep(ctx context.Context, _ time.Duration) error { return ctx.Err() }

func comfyTestGraph() map[string]interface{} {
	return map[string]interface{}{
		"1": map[string]interface{}{"class_type": "CLIPTextEncode", "inputs": map[string]interface{}{"text": "工作流默认提示词"}},
		"2": map[string]interface{}{"class_type": "LoadImage", "inputs": map[string]interface{}{"image": "工作流默认图片.png"}},
		"3": map[string]interface{}{"class_type": "SaveImage", "inputs": map[string]interface{}{"images": []interface{}{"2", float64(0)}}},
	}
}

func comfyImageInput(root string) Input {
	return Input{
		Mode:   "image",
		Prompt: "雨夜街头的猫",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceComfyUIImage),
			BaseURL:       root,
			APIKey:        "comfy-secret",
			WorkflowJSON:  comfyTestGraph(),
			WorkflowFields: []Field{
				{ID: "1::text", NodeID: "1", FieldName: "text", Source: "prompt"},
				{ID: "2::image", NodeID: "2", FieldName: "image", Source: "reference_image"},
			},
		},
		ReferenceImages: []Media{{ID: "ref-1", DataURL: "data:image/png;base64,AAAA"}},
	}
}

func completedComfyHistory() []byte {
	return []byte(`{"p-1":{"status":{"status_str":"success","completed":true},"outputs":{"3":{"images":[{"filename":"out_0001_.png","subfolder":"","type":"output"}]}}}}`)
}

func TestComfyUIPartialAcceptanceReportsValidationBeforePolling(t *testing.T) {
	root := allowLocalComfyUI(t)
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.HasSuffix(req.URL, "/upload/image"):
			return []byte(`{"name":"ref.png"}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/prompt"):
			return []byte(`{"prompt_id":"partial-1","node_errors":{"512":{"class_type":"KSampler","errors":[{"type":"value_not_in_list","message":"SECRET prompt","details":"/private/path","extra_info":{"input_name":"sampler_name","received_value":"SECRET"}}]}}}`), "application/json", nil
		default:
			t.Fatalf("must report partial acceptance before polling: %s", req.URL)
			return nil, "", nil
		}
	}}
	receipt := &memoryReceipt{}
	_, err := comfyTestClient(exec, receipt).Run(context.Background(), comfyImageInput(root))
	if err == nil || !strings.Contains(err.Error(), "部分输出节点校验失败") || !strings.Contains(err.Error(), "512 (KSampler) sampler_name") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "/private") {
		t.Fatalf("upstream values leaked: %v", err)
	}
	if ids := receipt.acceptedIDs(); len(ids) != 1 || ids[0] != "partial-1" {
		t.Fatalf("lost accepted job: %v", ids)
	}
}

func TestComfyUIPollsWhenPartialAcceptanceLoRAOnly(t *testing.T) {
	root := allowLocalComfyUI(t)
	graph := map[string]interface{}{
		"base": map[string]interface{}{"class_type": "CheckpointLoader", "inputs": map[string]interface{}{}},
		"522": map[string]interface{}{"class_type": "LoraLoaderModelOnly", "inputs": map[string]interface{}{
			"model": []interface{}{"base", float64(0)}, "lora_name": "missing.safetensors",
		}},
		"save": map[string]interface{}{"class_type": "SaveImage", "inputs": map[string]interface{}{"images": []interface{}{"522", float64(0)}}},
	}
	promptCalls := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.HasSuffix(req.URL, "/prompt"):
			promptCalls++
			return []byte(`{"prompt_id":"partial-lora","node_errors":{"522":{"class_type":"LoraLoaderModelOnly","errors":[{"type":"value_not_in_list","extra_info":{"input_name":"lora_name"}}]}}}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/history/partial-lora"):
			return []byte(`{"partial-lora":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}}}}`), "application/json", nil
		case strings.HasPrefix(req.URL, root+"/view?"):
			return []byte("png"), "image/png", nil
		}
		t.Fatalf("unexpected request %s", req.URL)
		return nil, "", nil
	}}
	input := Input{Mode: "image", Config: Config{InterfaceType: string(model.ChannelInterfaceComfyUIImage), BaseURL: root, WorkflowJSON: graph}}
	if _, err := comfyTestClient(exec, &memoryReceipt{}).Run(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if promptCalls != 1 {
		t.Fatalf("prompt calls = %d, want poll accepted job without resubmit", promptCalls)
	}
}

func TestComfyUIRetriesWithoutDeletedLoRA(t *testing.T) {
	root := allowLocalComfyUI(t)
	graph := map[string]interface{}{
		"base": map[string]interface{}{"class_type": "CheckpointLoader", "inputs": map[string]interface{}{}},
		"lora": map[string]interface{}{"class_type": "LoraLoader", "inputs": map[string]interface{}{
			"model": []interface{}{"base", float64(0)}, "clip": []interface{}{"base", float64(1)}, "lora_name": "NSFW Qwen by TheseAlpacas V2.safetensors",
		}},
		"save": map[string]interface{}{"class_type": "SaveImage", "inputs": map[string]interface{}{"images": []interface{}{"lora", float64(0)}}},
	}
	promptCalls := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.HasSuffix(req.URL, "/prompt"):
			promptCalls++
			if promptCalls == 1 {
				return []byte(`{"node_errors":{"lora":{"class_type":"LoraLoader","errors":[{"type":"value_not_in_list","extra_info":{"input_name":"lora_name"}}]}}}`), "application/json", nil
			}
			var submitted map[string]interface{}
			if err := json.Unmarshal(req.Body, &submitted); err != nil {
				t.Fatal(err)
			}
			if _, exists := submitted["prompt"].(map[string]interface{})["lora"]; exists {
				t.Fatalf("stale LoRA was submitted again: %s", req.Body)
			}
			return []byte(`{"prompt_id":"without-lora"}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/history/without-lora"):
			return []byte(`{"without-lora":{"status":{"status_str":"success","completed":true},"outputs":{"save":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}}}}`), "application/json", nil
		case strings.HasPrefix(req.URL, root+"/view?"):
			return []byte("png"), "image/png", nil
		}
		t.Fatalf("unexpected request %s", req.URL)
		return nil, "", nil
	}}
	input := Input{Mode: "image", Config: Config{InterfaceType: string(model.ChannelInterfaceComfyUIImage), BaseURL: root, WorkflowJSON: graph}}
	if _, err := comfyTestClient(exec, &memoryReceipt{}).Run(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if promptCalls != 2 {
		t.Fatalf("prompt calls = %d", promptCalls)
	}
}

func TestComfyUITextOnlyHistoryIsNotAMediaResult(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.Method != http.MethodGet || !strings.HasSuffix(req.URL, "/history/text-only") {
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL)
		}
		return []byte(`{"text-only":{"status":{"status_str":"success","completed":true},"outputs":{"529":{"text":["not an image"]}}}}`), "application/json", nil
	}}
	_, stage, err := comfyTestClient(exec, &memoryReceipt{}).QueryComfyUI(context.Background(), Config{BaseURL: "https://comfy.example"}, "text-only", "image")
	if stage != "failed" || err == nil || !strings.Contains(err.Error(), "媒体输出节点") {
		t.Fatalf("stage=%s err=%v", stage, err)
	}
}

func comfyTestClient(exec RequestExecutor, receipt Receipt) *Client {
	return &Client{Requests: exec, Media: stubMedia{}, Receipt: receipt, Plugins: allowPlugin{}, Time: wakeImmediately{}}
}

func TestComfyUIRunUploadsSubmitsPollsAndDownloads(t *testing.T) {
	root := allowLocalComfyUI(t)
	var historyQueries int
	var submitted map[string]interface{}
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.HasSuffix(req.URL, "/upload/image"):
			if req.Method != http.MethodPost || !strings.HasPrefix(req.ContentType, "multipart/form-data") {
				t.Fatalf("upload = %s %s", req.Method, req.ContentType)
			}
			return []byte(`{"name":"ref-1.png","subfolder":"input","type":"input"}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/prompt"):
			if req.Method != http.MethodPost {
				t.Fatalf("prompt method = %s", req.Method)
			}
			if err := json.Unmarshal(req.Body, &submitted); err != nil {
				t.Fatalf("prompt body = %s", req.Body)
			}
			return []byte(`{"prompt_id":"p-1"}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/history/p-1"):
			historyQueries++
			if historyQueries == 1 {
				return []byte(`{}`), "application/json", nil
			}
			return completedComfyHistory(), "application/json", nil
		case strings.HasPrefix(req.URL, root+"/view?"):
			return []byte("png-bytes"), "image/png", nil
		}
		t.Fatalf("unexpected request %s %s", req.Method, req.URL)
		return nil, "", nil
	}}
	receipt := &memoryReceipt{}

	result, err := comfyTestClient(exec, receipt).Run(context.Background(), comfyImageInput(root))
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "image" {
		t.Fatalf("result = %#v", result)
	}
	images, _ := result["images"].([]map[string]interface{})
	if len(images) != 1 {
		t.Fatalf("images = %#v", result["images"])
	}
	if accepted := receipt.acceptedIDs(); len(accepted) != 1 || accepted[0] != "p-1" {
		t.Fatalf("accepted receipts = %#v", accepted)
	}
	promptGraph, _ := submitted["prompt"].(map[string]interface{})
	nodeOne, _ := promptGraph["1"].(map[string]interface{})
	inputs, _ := nodeOne["inputs"].(map[string]interface{})
	if inputs["text"] != "雨夜街头的猫" {
		t.Fatalf("prompt text = %#v", inputs["text"])
	}
	nodeTwo, _ := promptGraph["2"].(map[string]interface{})
	nodeTwoInputs, _ := nodeTwo["inputs"].(map[string]interface{})
	if nodeTwoInputs["image"] != "ref-1.png" {
		t.Fatalf("reference input = %#v", nodeTwoInputs["image"])
	}
	// 连线输入必须原样保留，否则保存节点会拿不到上游产物。
	nodeThree, _ := promptGraph["3"].(map[string]interface{})
	nodeThreeInputs, _ := nodeThree["inputs"].(map[string]interface{})
	if link, ok := nodeThreeInputs["images"].([]interface{}); !ok || len(link) != 2 || link[0] != "2" {
		t.Fatalf("linked images input = %#v", nodeThreeInputs["images"])
	}
	// 上游只在配置的实例上通信，并带上用户配置的密钥。
	for _, call := range exec.calls {
		var authorized bool
		for _, header := range call.Headers {
			if header.Name == "Authorization" && header.Value == "Bearer comfy-secret" {
				authorized = true
			}
		}
		if !authorized {
			t.Fatalf("request %s has no host Authorization header: %#v", call.URL, call.Headers)
		}
	}
	paths := exec.paths()
	if len(paths) != 5 || !strings.HasSuffix(paths[0], "/upload/image") || !strings.HasSuffix(paths[1], "/prompt") {
		t.Fatalf("request order = %#v", paths)
	}
}

func TestComfyUIRunRejectsUnusableReferenceMappingBeforeUpload(t *testing.T) {
	for name, field := range map[string]Field{
		"disabled": {NodeID: "2", FieldName: "image", Source: "reference_image", Enabled: ptr(false)},
		"unsafe":   {NodeID: "2", FieldName: "image", Source: "reference_image", SafeToOverride: ptr(false)},
	} {
		t.Run(name, func(t *testing.T) {
			input := comfyImageInput(allowLocalComfyUI(t))
			input.Config.WorkflowFields[1] = field
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				t.Fatalf("unusable reference mapping must fail before outbound request: %s", req.URL)
				return nil, "", nil
			}}
			_, err := comfyTestClient(exec, &memoryReceipt{}).Run(context.Background(), input)
			if err == nil || !strings.Contains(err.Error(), "0 个参考图片槽位") {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestComfyUIRunResumesAcceptedPromptWithoutSubmittingAgain(t *testing.T) {
	root := allowLocalComfyUI(t)
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.HasSuffix(req.URL, "/prompt") || strings.HasSuffix(req.URL, "/upload/image"):
			t.Fatal("恢复已受理任务不能重新提交工作流")
		case strings.HasSuffix(req.URL, "/history/p-9"):
			return []byte(`{"p-9":{"status":{"status_str":"success","completed":true},"outputs":{"3":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}}}}`), "application/json", nil
		case strings.HasPrefix(req.URL, root+"/view?"):
			return []byte("png-bytes"), "image/png", nil
		}
		t.Fatalf("unexpected request %s %s", req.Method, req.URL)
		return nil, "", nil
	}}
	input := comfyImageInput(root)
	input.ResumedRequestID = "p-9"

	result, err := comfyTestClient(exec, &memoryReceipt{}).Run(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "image" {
		t.Fatalf("result = %#v", result)
	}
}

func TestComfyUIRunReportsFailedExecution(t *testing.T) {
	root := allowLocalComfyUI(t)
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.HasSuffix(req.URL, "/upload/image"):
			return []byte(`{"name":"ref-1.png","subfolder":"input","type":"input"}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/prompt"):
			return []byte(`{"prompt_id":"p-1"}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/history/p-1"):
			return []byte(`{"p-1":{"status":{"status_str":"error","completed":true}}}`), "application/json", nil
		}
		t.Fatalf("unexpected request %s %s", req.Method, req.URL)
		return nil, "", nil
	}}

	_, err := comfyTestClient(exec, &memoryReceipt{}).Run(context.Background(), comfyImageInput(root))
	if err == nil || !strings.Contains(err.Error(), "执行失败") {
		t.Fatalf("err = %v", err)
	}
}

func TestComfyUIRunRejectsReferencesBeyondWorkflowLimits(t *testing.T) {
	root := allowLocalComfyUI(t)
	exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		t.Fatal("超上限的参考素材不能提交到 ComfyUI")
		return nil, "", nil
	}}
	input := comfyImageInput(root)
	input.ReferenceImages = make([]Media, comfyMaxReferenceImages+1)
	for index := range input.ReferenceImages {
		input.ReferenceImages[index] = Media{ID: "img", DataURL: "data:image/png;base64,AAAA"}
	}

	_, err := comfyTestClient(exec, &memoryReceipt{}).Run(context.Background(), input)
	if err == nil || !strings.Contains(err.Error(), "最多支持") {
		t.Fatalf("err = %v", err)
	}
}

func TestComfyUIVideoConfigRejectsMiniMaxH3LongerThanFifteenSeconds(t *testing.T) {
	root := allowLocalComfyUI(t)
	graph := map[string]interface{}{
		"1": map[string]interface{}{"class_type": "MiniMaxH3ReferenceToVideo", "inputs": map[string]interface{}{"prompt": ""}},
	}
	config := Config{
		InterfaceType: string(model.ChannelInterfaceComfyUIVideo),
		BaseURL:       root,
		WorkflowJSON:  graph,
		VideoSeconds:  "20",
	}
	err := ValidateConfig("video", config)
	if err == nil || !strings.Contains(err.Error(), "15 秒") {
		t.Fatalf("err = %v", err)
	}
	if _, err := outbound.ValidateOutboundURL(root); err != nil {
		t.Fatalf("allowlisted local ComfyUI must stay usable: %v", err)
	}
}
