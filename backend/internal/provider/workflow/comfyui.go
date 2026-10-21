package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/outbound"
)

const (
	comfyMaxReferenceImages = 9
	comfyMaxReferenceVideos = 3
	comfyMaxReferenceAudios = 3
	comfyMaxH3Seconds       = 15
)

func isDefinitiveComfySubmissionRejection(statusCode int) bool {
	return statusCode >= http.StatusBadRequest &&
		statusCode < http.StatusInternalServerError &&
		statusCode != http.StatusRequestTimeout &&
		statusCode != http.StatusTooManyRequests &&
		statusCode != http.StatusTooEarly
}

func comfyUIRootURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func comfyUIHeaders(config Config) []outbound.OutboundHeader {
	headers := make([]outbound.OutboundHeader, 0, len(config.Headers)+1)
	for _, header := range config.Headers {
		headers = append(headers, header)
	}
	if strings.TrimSpace(config.APIKey) != "" {
		found := false
		for _, header := range headers {
			if strings.EqualFold(header.Name, "Authorization") {
				found = true
				break
			}
		}
		if !found {
			headers = append(headers, outbound.OutboundHeader{Name: "Authorization", Value: "Bearer " + strings.TrimSpace(config.APIKey)})
		}
	}
	return headers
}

func (c *Client) runComfyUI(ctx context.Context, input Input) (map[string]interface{}, error) {
	if err := ValidateConfig(input.Mode, input.Config); err != nil {
		return nil, err
	}
	if err := validateComfyReferences(input); err != nil {
		return nil, err
	}
	if err := c.requireActor(ctx, input.Config.InterfaceType); err != nil {
		return nil, err
	}
	root := comfyUIRootURL(input.Config.BaseURL)
	if resumed := strings.TrimSpace(input.ResumedRequestID); resumed != "" {
		return c.pollComfyUI(ctx, input.Config, root, resumed, input.Mode)
	}
	if err := c.requirePaidCreate(ctx); err != nil {
		return nil, err
	}
	if c.Media == nil && (len(input.ReferenceImages) > 0 || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 || input.Mask != nil) {
		return nil, errors.New("ComfyUI 工作流缺少受保护的素材读取端口")
	}
	graph, err := cloneComfyWorkflow(input.Config.WorkflowJSON)
	if err != nil {
		return nil, err
	}
	source := input.Config.SourceWorkflowJSON
	// A cached API graph has already lost bypassed loaders. H3 must retain the
	// source even when this request fits the cached image-only capacity.
	if len(source) == 0 && isMiniMaxH3Workflow(graph) && strings.TrimSpace(input.Config.WorkflowID) != "" {
		refreshed, refreshErr := c.FetchComfyUIWorkflow(ctx, input.Config, input.Config.WorkflowID)
		if refreshErr != nil {
			return nil, refreshErr
		}
		source, _ = refreshed["sourceWorkflowJson"].(map[string]any)
	}
	if len(source) > 0 {
		graph, err = comfySavedWorkflowToAPIForInput(source, input)
		if err != nil {
			return nil, err
		}
	}
	saved := comfyExecutionFields(input.Config.WorkflowFields, graph)
	fields, err := ensureWorkflowFieldsForMediaInputs(saved, graph, input.Mode, input)
	if err != nil {
		return nil, err
	}
	files := make(map[string]string)
	for _, media := range append(append(append([]Media{}, input.ReferenceImages...), input.ReferenceVideos...), input.ReferenceAudios...) {
		name, uploadErr := c.uploadComfyMedia(ctx, root, input.Config, media)
		if uploadErr != nil {
			return nil, uploadErr
		}
		files[media.ID] = name
	}
	if input.Mask != nil {
		name, uploadErr := c.uploadComfyMedia(ctx, root, input.Config, *input.Mask)
		if uploadErr != nil {
			return nil, uploadErr
		}
		files[input.Mask.ID] = name
	}
	if err := applyComfyWorkflowFields(graph, fields, files, input); err != nil {
		return nil, err
	}
	normalizeComfyListedModelNames(graph)
	const maxComfyLoRABypassAttempts = 8
	var submitted map[string]interface{}
	for attempt := 0; attempt < maxComfyLoRABypassAttempts; attempt++ {
		normalizeComfyListedModelNames(graph)
		var err error
		submitted, err = c.submitComfyPrompt(ctx, input.Config, root, graph)
		if err != nil {
			var rejected *comfyPromptRejectedError
			if errors.As(err, &rejected) && comfyNodeErrorsFixableListedModelPath(rejected.nodeErrors) {
				continue
			}
			if errors.As(err, &rejected) && comfyNodeErrorsBypassableLoRAOnly(rejected.nodeErrors) {
				if bypassed, bypassErr := bypassRejectedComfyLoRAs(graph, comfyRejectedLoRANodes(rejected.nodeErrors)); bypassErr == nil && bypassed {
					continue
				}
			}
			return nil, err
		}
		promptID := strings.TrimSpace(stringValue(submitted["prompt_id"]))
		if comfyNodeErrorsBypassableLoRAOnly(submitted["node_errors"]) {
			if promptID != "" {
				// ComfyUI may accept the prompt and still finish valid output branches while
				// reporting dead LoRA loaders in node_errors. Poll that job instead of failing
				// the product task while images already exist upstream.
				if err := c.Receipt.RecordAccepted(ctx, promptID, "submitted", nil); err != nil {
					c.Progress.Log(ctx, "error", "ComfyUI 请求状态保存失败", promptID+"："+err.Error())
					return nil, AcceptedNotRecorded{RequestID: promptID, Stage: "submitted", Err: err}
				}
				return c.pollComfyUI(ctx, input.Config, root, promptID, input.Mode)
			}
			if bypassed, bypassErr := bypassRejectedComfyLoRAs(graph, comfyRejectedLoRANodes(submitted["node_errors"])); bypassErr == nil && bypassed {
				continue
			}
		}
		if promptID == "" {
			if comfyNodeErrorsFixableListedModelPath(submitted["node_errors"]) {
				continue
			}
			if detail := comfyNodeValidationSummary(submitted["node_errors"]); detail != "" {
				return nil, fmt.Errorf("ComfyUI 工作流节点校验失败：%s", detail)
			}
			return nil, CreateUncertain{Err: errors.New("ComfyUI 未返回 prompt_id")}
		}
		if detail := comfyNodeValidationSummary(submitted["node_errors"]); detail != "" {
			if err := c.Receipt.RecordAccepted(ctx, promptID, "submitted", nil); err != nil {
				c.Progress.Log(ctx, "error", "ComfyUI 请求状态保存失败", promptID+"："+err.Error())
				return nil, AcceptedNotRecorded{RequestID: promptID, Stage: "submitted", Err: err}
			}
			return nil, fmt.Errorf("ComfyUI 部分输出节点校验失败，已保留上游任务 ID；请修正工作流后再生成：%s", detail)
		}
		if err := c.Receipt.RecordAccepted(ctx, promptID, "submitted", nil); err != nil {
			c.Progress.Log(ctx, "error", "ComfyUI 请求状态保存失败", promptID+"："+err.Error())
			return nil, AcceptedNotRecorded{RequestID: promptID, Stage: "submitted", Err: err}
		}
		return c.pollComfyUI(ctx, input.Config, root, promptID, input.Mode)
	}
	return nil, errors.New("ComfyUI 工作流 LoRA 旁路重试次数耗尽")
}

func comfyExecutionFields(saved []Field, graph map[string]any) []Field {
	if !isMiniMaxH3Workflow(graph) {
		return saved
	}
	// Settings include every optional loader; inactive loaders are absent from
	// this execution graph. Infer active media bindings again from target slots.
	inferred, _ := workflowFieldsFromManagement(graph, "video")
	mediaByKey := make(map[string]Field)
	controlsByKey := make(map[string]Field)
	for _, field := range inferred {
		if isComfyMediaField(field) {
			mediaByKey[fieldMappingKey(field)] = field
		}
		if field.Role == "business" && (field.Source == "videoSeconds" || field.Source == "vquality" || field.Source == "aspectRatio") {
			controlsByKey[fieldMappingKey(field)] = field
		}
	}
	fields := make([]Field, 0, len(saved))
	for _, field := range saved {
		if _, exists := graph[strings.TrimSpace(field.NodeID)]; !exists {
			continue
		}
		if binding, exists := mediaByKey[fieldMappingKey(field)]; exists && isComfyMediaField(field) {
			field.Source = binding.Source
			field.SourceIndex = binding.SourceIndex
			field.ImageOrder = binding.ImageOrder
		}
		if binding, exists := controlsByKey[fieldMappingKey(field)]; exists && field.Role == "internal" && field.SourceAutomatic != nil && *field.SourceAutomatic && (field.SafeToOverride == nil || *field.SafeToOverride) {
			field.Source, field.Role, field.Enabled = binding.Source, binding.Role, binding.Enabled
		}
		fields = append(fields, field)
	}
	merged := unionInferredMediaReferenceFields(mergeWorkflowExecutionFields(fields, inferred), inferred)
	present := make(map[string]bool, len(merged))
	for _, field := range merged {
		present[fieldMappingKey(field)] = true
	}
	for key, field := range controlsByKey {
		if !present[key] {
			merged = append(merged, field)
		}
	}
	return merged
}

func (c *Client) submitComfyPrompt(ctx context.Context, config Config, root string, graph map[string]interface{}) (map[string]interface{}, error) {
	normalizeComfyListedModelNames(graph)
	body, err := json.Marshal(map[string]interface{}{"prompt": graph})
	if err != nil {
		return nil, fmt.Errorf("ComfyUI 工作流编码失败：%w", err)
	}
	response, _, err := c.execute(ctx, Request{
		Kind:        "create",
		Method:      http.MethodPost,
		URL:         root + "/prompt",
		Headers:     comfyOutboundHeaders(config),
		ContentType: "application/json",
		Body:        body,
	})
	if err != nil {
		var statusErr StatusError
		if errors.As(err, &statusErr) {
			if nodeErrors := comfyNodeErrorsFromBody(statusErr.Body); nodeErrors != nil {
				if detail := comfyNodeValidationSummary(nodeErrors); detail != "" {
					return nil, &comfyPromptRejectedError{nodeErrors: nodeErrors, detail: detail}
				}
			}
		}
		if errors.As(err, &statusErr) && isDefinitiveComfySubmissionRejection(statusErr.StatusCode) {
			return nil, fmt.Errorf("ComfyUI 工作流提交失败：%w", err)
		}
		return nil, CreateUncertain{Err: fmt.Errorf("ComfyUI 工作流提交失败：%w", err)}
	}
	var submitted map[string]interface{}
	if err := json.Unmarshal(response, &submitted); err != nil {
		return nil, CreateUncertain{Err: errors.New("ComfyUI 提交响应不是有效 JSON")}
	}
	return submitted, nil
}

type comfyPromptRejectedError struct {
	nodeErrors any
	detail     string
}

func (e *comfyPromptRejectedError) Error() string {
	return "ComfyUI 工作流提交被节点校验拒绝：" + e.detail
}

var comfyDiagnosticIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,80}$`)

func comfyNodeValidationSummary(value any) string {
	nodes, ok := value.(map[string]any)
	if !ok || len(nodes) == 0 {
		return ""
	}
	ids := make([]string, 0, len(nodes))
	for id := range nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var details []string
	for _, id := range ids {
		if len(details) == 6 {
			break
		}
		node, _ := nodes[id].(map[string]any)
		label := "节点"
		if comfyDiagnosticIdentifier.MatchString(id) {
			label += " " + id
		}
		if class := workflowScalarString(node["class_type"]); comfyDiagnosticIdentifier.MatchString(class) {
			label += " (" + class + ")"
		}
		var reasons []string
		items, _ := node["errors"].([]any)
		for _, item := range items {
			if len(reasons) == 3 {
				break
			}
			entry, _ := item.(map[string]any)
			reason := "输入校验失败"
			extra, _ := entry["extra_info"].(map[string]any)
			field := workflowScalarString(extra["input_name"])
			if !comfyDiagnosticIdentifier.MatchString(field) {
				field = ""
			}
			switch workflowScalarString(entry["type"]) {
			case "value_not_in_list":
				reason = comfyInvalidOptionSummary(field, extra["received_value"], workflowScalarString(entry["details"]))
			case "required_input_missing":
				reason = "缺少必需输入"
			case "invalid_input_type", "return_type_mismatch":
				reason = "输入类型不匹配"
			}
			if field != "" && workflowScalarString(entry["type"]) != "value_not_in_list" {
				reason = field + "：" + reason
			}
			// Raw message/details/extra_info may echo prompts, credentials or paths.
			reasons = append(reasons, reason)
		}
		if len(reasons) > 0 {
			label += " " + strings.Join(reasons, "，")
		}
		details = append(details, label)
	}
	return strings.Join(details, "；")
}

func comfyNodeValidationSummaryFromBody(body string) string {
	return comfyNodeValidationSummary(comfyNodeErrorsFromBody(body))
}

func comfyNodeErrorsFromBody(body string) any {
	var response map[string]any
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		return nil
	}
	return response["node_errors"]
}

func comfyRejectedLoRANodes(value any) map[string]bool {
	nodes, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	rejected := make(map[string]bool)
	for id, raw := range nodes {
		if comfyNodeErrorsBypassableLoRAOnly(map[string]any{id: raw}) {
			rejected[id] = true
		}
	}
	return rejected
}

func comfyNodeErrorsBypassableLoRAOnly(value any) bool {
	nodes, ok := value.(map[string]any)
	if !ok || len(nodes) == 0 {
		return false
	}
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		if !strings.Contains(strings.ToLower(workflowScalarString(node["class_type"])), "lora") {
			return false
		}
		items, _ := node["errors"].([]any)
		if len(items) == 0 {
			return false
		}
		for _, item := range items {
			entry, _ := item.(map[string]any)
			extra, _ := entry["extra_info"].(map[string]any)
			if workflowScalarString(entry["type"]) != "value_not_in_list" || !isComfyLoRAField(workflowScalarString(extra["input_name"])) {
				return false
			}
		}
	}
	return true
}

// A deleted LoRA should not block the entire workflow. Standard LoRA loaders
// forward their MODEL and CLIP inputs when bypassed, so reconnect those outputs
// and remove the rejected loader before one safe retry.
func bypassRejectedComfyLoRAs(graph map[string]interface{}, rejected map[string]bool) (bool, error) {
	if len(rejected) == 0 {
		return false, nil
	}
	replacements := make(map[string]map[int][]interface{})
	for id := range rejected {
		node, ok := graph[id].(map[string]interface{})
		if !ok || !strings.Contains(strings.ToLower(workflowScalarString(node["class_type"])), "lora") {
			return false, fmt.Errorf("被拒绝的 LoRA 节点 %s 不可旁路", id)
		}
		inputs, ok := node["inputs"].(map[string]interface{})
		if !ok {
			return false, fmt.Errorf("LoRA 节点 %s 缺少 inputs", id)
		}
		model, ok := inputs["model"].([]interface{})
		if !ok || !isWorkflowLinkValue(model) {
			return false, fmt.Errorf("LoRA 节点 %s 缺少可旁路的模型输入", id)
		}
		outputs := map[int][]interface{}{0: model}
		if clip, ok := inputs["clip"].([]interface{}); ok && isWorkflowLinkValue(clip) {
			outputs[1] = clip
		}
		replacements[id] = outputs
	}
	for _, raw := range graph {
		node, _ := raw.(map[string]interface{})
		inputs, _ := node["inputs"].(map[string]interface{})
		for name, rawValue := range inputs {
			link, ok := rawValue.([]interface{})
			if !ok || !isWorkflowLinkValue(link) {
				continue
			}
			sourceID := workflowScalarString(link[0])
			outputIndex, ok := workflowLinkOutputIndex(link[1])
			if !ok || replacements[sourceID] == nil {
				continue
			}
			replacement, exists := replacements[sourceID][outputIndex]
			if !exists {
				return false, fmt.Errorf("LoRA 节点 %s 的输出 %d 无法旁路", sourceID, outputIndex)
			}
			inputs[name] = replacement
		}
	}
	for id := range replacements {
		delete(graph, id)
	}
	return true, nil
}

func workflowLinkOutputIndex(value any) (int, bool) {
	switch index := value.(type) {
	case float64:
		if index >= 0 && index == float64(int(index)) {
			return int(index), true
		}
	case int:
		if index >= 0 {
			return index, true
		}
	}
	return 0, false
}

func comfyInvalidOptionSummary(field string, received any, details string) string {
	label := "参数不在 ComfyUI 当前可选值中"
	if field != "" {
		label = field + "：" + label
	}
	if isComfyLoRAField(field) {
		label = "LoRA 模型不可用，可能已被删除"
	}
	if field != "clip_name" && !isComfyLoRAField(field) {
		return label
	}
	value := workflowScalarString(received)
	// ComfyUI file inputs enumerate names relative to their model directory.
	// Show the selected filename without exposing local path components.
	if strings.ContainsAny(value, "/\\") {
		value = path.Base(strings.ReplaceAll(value, "\\", "/"))
	}
	if len(value) > 120 || strings.Contains(value, "://") || (value != "" && !safeComfyModelFilename(value)) {
		value = ""
	}
	if !strings.ContainsAny(details, "[]") {
		details = ""
	}
	start := strings.Index(details, "not in [")
	end := strings.LastIndex(details, "]")
	var choices []string
	if start >= 0 && end > start+len("not in [") {
		for _, raw := range strings.Split(details[start+len("not in ["):end], ",") {
			choice := strings.Trim(strings.TrimSpace(raw), "'\"")
			choice = path.Base(strings.ReplaceAll(choice, "\\", "/"))
			if safeComfyModelFilename(choice) {
				choices = append(choices, choice)
				if len(choices) == 4 {
					break
				}
			}
		}
	}
	if value != "" {
		label += "（当前值：" + value + "）"
	}
	if len(choices) > 0 {
		label += "；可选示例：" + strings.Join(choices, "、")
	}
	return label
}

func isComfyLoRAField(field string) bool {
	return strings.Contains(strings.ToLower(strings.TrimSpace(field)), "lora")
}

func safeComfyModelFilename(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 120 || strings.ContainsAny(value, "/\\") {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char >= 0x4e00 && char <= 0x9fff || strings.ContainsRune(" ._-()[]", char) {
			continue
		}
		return false
	}
	return true
}

func comfyExecutionFailureSummary(value any) string {
	messages, ok := value.([]any)
	if !ok {
		return "ComfyUI 工作流执行失败"
	}
	for _, raw := range messages {
		entry, ok := raw.([]any)
		if !ok || len(entry) < 2 || workflowScalarString(entry[0]) != "execution_error" {
			continue
		}
		details, _ := entry[1].(map[string]any)
		text := strings.ToLower(workflowScalarString(details["exception_message"]) + " " + workflowScalarString(details["exception_type"]))
		if strings.Contains(text, "lora") && (strings.Contains(text, "not found") || strings.Contains(text, "no lora") || strings.Contains(text, "does not exist")) {
			return "LoRA 模型不可用，可能已被删除。请在 ComfyUI 工作流中选择仍存在的 LoRA，或移除该 LoRA 节点后重试"
		}
	}
	return "ComfyUI 工作流执行失败"
}

func normalizeComfyListedModelNames(graph map[string]interface{}) {
	for _, raw := range graph {
		node, _ := raw.(map[string]interface{})
		inputs, _ := node["inputs"].(map[string]interface{})
		if inputs == nil {
			continue
		}
		for key, rawValue := range inputs {
			if !isComfyListedModelField(key) {
				continue
			}
			name := workflowScalarString(rawValue)
			if name == "" {
				continue
			}
			normalized := normalizeComfyListedModelFilename(name)
			if normalized != name || workflowScalarString(rawValue) != normalized {
				inputs[key] = normalized
			}
		}
	}
}

func isComfyListedModelField(key string) bool {
	key = strings.TrimSpace(key)
	if key == "" {
		return false
	}
	lower := strings.ToLower(key)
	if strings.HasPrefix(lower, "clip_name") {
		return true
	}
	switch lower {
	case "ckpt_name", "lora_name", "unet_name", "vae_name", "weight_name", "model_name", "filename", "style_model_name", "control_net_name":
		return true
	default:
		return false
	}
}

func comfyNodeErrorsFixableListedModelPath(value any) bool {
	nodes, ok := value.(map[string]any)
	if !ok || len(nodes) == 0 {
		return false
	}
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		items, _ := node["errors"].([]any)
		for _, item := range items {
			entry, _ := item.(map[string]any)
			if workflowScalarString(entry["type"]) != "value_not_in_list" {
				continue
			}
			extra, _ := entry["extra_info"].(map[string]any)
			field := workflowScalarString(extra["input_name"])
			if !isComfyListedModelField(field) {
				continue
			}
			received := workflowScalarString(extra["received_value"])
			if received == "" {
				received = workflowScalarString(entry["details"])
			}
			if strings.Contains(received, "/") || strings.Contains(received, "\\") {
				return true
			}
			if normalized := normalizeComfyListedModelFilename(received); normalized != received && normalized != "" {
				return true
			}
		}
	}
	return false
}

func normalizeComfyListedModelFilename(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || !strings.ContainsAny(name, "/\\") {
		return name
	}
	// ComfyUI list inputs validate against folder-relative filenames; saved graphs
	// often keep models/ or text_encoders/ style prefixes from export tools.
	normalized := strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "./")
	for {
		before := normalized
		for _, prefix := range []string{
			"models/",
			"text_encoders/",
			"clip/",
			"checkpoints/",
			"loras/",
			"unet/",
			"vae/",
			"diffusion_models/",
			"controlnet/",
			"style_models/",
		} {
			if strings.HasPrefix(strings.ToLower(normalized), prefix) {
				normalized = normalized[len(prefix):]
				break
			}
		}
		if normalized == before {
			break
		}
	}
	if strings.ContainsAny(normalized, "/\\") {
		normalized = path.Base(normalized)
	}
	return normalized
}

func comfyOutboundHeaders(config Config) []outbound.OutboundHeader {
	return comfyUIHeaders(config)
}

func (c *Client) uploadComfyMedia(ctx context.Context, root string, config Config, media Media) (string, error) {
	raw, mimeType, err := c.Media.LocalBytes(media)
	if err != nil && isPublicMediaURL(strings.TrimSpace(media.URL)) {
		raw, mimeType, err = c.execute(ctx, Request{Kind: "upload", Method: http.MethodGet, URL: strings.TrimSpace(media.URL)})
	}
	if err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return "", errors.New("ComfyUI 参考素材为空")
	}
	if strings.TrimSpace(mimeType) == "" {
		mimeType = http.DetectContentType(raw)
	}
	filename := strings.TrimSpace(media.Name)
	if filename == "" {
		filename = mediaFilename(media, mimeType)
	}
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	_ = writer.WriteField("overwrite", "true")
	_ = writer.WriteField("type", "input")
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "image", "filename": filepath.Base(filename)}))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(raw); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	response, _, err := c.execute(ctx, Request{
		Kind:        "upload",
		Method:      http.MethodPost,
		URL:         root + "/upload/image",
		Headers:     comfyOutboundHeaders(config),
		ContentType: writer.FormDataContentType(),
		Body:        body.Bytes(),
	})
	if err != nil {
		return "", fmt.Errorf("ComfyUI 参考素材上传失败：%w", err)
	}
	var uploaded struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(response, &uploaded); err != nil || strings.TrimSpace(uploaded.Name) == "" {
		return "", errors.New("ComfyUI 上传响应缺少文件名")
	}
	return uploaded.Name, nil
}

func cloneComfyWorkflow(source map[string]interface{}) (map[string]interface{}, error) {
	encoded, err := json.Marshal(source)
	if err != nil {
		return nil, fmt.Errorf("ComfyUI 工作流 JSON 无效：%w", err)
	}
	var graph map[string]interface{}
	if err := json.Unmarshal(encoded, &graph); err != nil || len(graph) == 0 {
		return nil, errors.New("ComfyUI 工作流必须是非空 API 格式 JSON 对象")
	}
	for id, raw := range graph {
		node, ok := raw.(map[string]interface{})
		if !ok || strings.TrimSpace(stringValue(node["class_type"])) == "" {
			return nil, fmt.Errorf("ComfyUI 工作流节点 %s 缺少 class_type", id)
		}
		if _, ok := node["inputs"].(map[string]interface{}); !ok {
			return nil, fmt.Errorf("ComfyUI 工作流节点 %s 缺少 inputs", id)
		}
	}
	normalizeComfyListedModelNames(graph)
	return graph, nil
}

func applyComfyWorkflowFields(graph map[string]interface{}, fields []Field, files map[string]string, input Input) error {
	for _, field := range fields {
		if field.Enabled != nil && !*field.Enabled {
			continue
		}
		nodeID := strings.TrimSpace(field.NodeID)
		fieldName := strings.TrimSpace(field.FieldName)
		if nodeID == "" || fieldName == "" {
			continue
		}
		node, ok := graph[nodeID].(map[string]interface{})
		if !ok {
			return fmt.Errorf("ComfyUI 工作流字段 %s 引用的节点 %s 不存在", firstNonEmpty(field.ID, fieldName), nodeID)
		}
		inputs, ok := node["inputs"].(map[string]interface{})
		if !ok {
			return fmt.Errorf("ComfyUI 工作流节点 %s 缺少 inputs", nodeID)
		}
		original, exists := inputs[fieldName]
		if !exists {
			return fmt.Errorf("ComfyUI 工作流节点 %s 不存在输入字段 %s", nodeID, fieldName)
		}
		if isWorkflowLinkValue(original) {
			continue
		}
		if field.SafeToOverride != nil && !*field.SafeToOverride {
			continue
		}
		value, present, err := resolveWorkflowFieldValue(field, files, input)
		if err != nil {
			return err
		}
		if !present {
			if field.Required && !isComfyMediaField(field) {
				return fmt.Errorf("ComfyUI 工作流字段 %s 缺少值", firstNonEmpty(field.ID, fieldName))
			}
			continue
		}
		inputs[fieldName] = value
	}
	return nil
}

func isComfyMediaField(field Field) bool {
	source := strings.ReplaceAll(strings.ReplaceAll(normalizeWorkflowFieldSource(field), "_", ""), "-", "")
	switch source {
	case "referenceimage", "image", "referenceimages", "referencevideo", "video", "referencevideos", "referenceaudio", "audio", "referenceaudios", "mask":
		return true
	default:
		return false
	}
}

func validateComfyReferences(input Input) error {
	if len(input.ReferenceImages) > comfyMaxReferenceImages {
		return fmt.Errorf("ComfyUI 工作流最多支持 %d 张参考图片", comfyMaxReferenceImages)
	}
	if len(input.ReferenceVideos) > comfyMaxReferenceVideos {
		return fmt.Errorf("ComfyUI 工作流最多支持 %d 个参考视频", comfyMaxReferenceVideos)
	}
	if len(input.ReferenceAudios) > comfyMaxReferenceAudios {
		return fmt.Errorf("ComfyUI 工作流最多支持 %d 个参考音频", comfyMaxReferenceAudios)
	}
	if isMiniMaxH3Workflow(input.Config.WorkflowJSON) && input.Mode == "video" {
		seconds, err := strconv.ParseFloat(strings.TrimSpace(input.Config.VideoSeconds), 64)
		if err == nil && seconds > comfyMaxH3Seconds {
			return errors.New("MiniMax H3 单次生成时长不能超过 15 秒")
		}
	}
	return nil
}

type comfyOutputFile struct {
	Filename  string `json:"filename"`
	Subfolder string `json:"subfolder"`
	Type      string `json:"type"`
}

func (c *Client) pollComfyUI(ctx context.Context, config Config, root, promptID, mode string) (map[string]interface{}, error) {
	if strings.TrimSpace(promptID) == "" {
		return nil, errors.New("ComfyUI 缺少 prompt_id")
	}
	query := func(ctx context.Context) (PollOutcome, error) {
		outputs, stage, err := c.queryComfyHistory(ctx, config, root, promptID)
		if err != nil {
			return PollOutcome{}, err
		}
		if stage == "failed" {
			return PollOutcome{}, errors.New("ComfyUI 工作流执行失败")
		}
		if stage != "succeeded" {
			interval := c.Time.LegacyPollInterval()
			next := c.Time.Now().Add(interval)
			c.updateReceipt(ctx, promptID, stage, &next)
			return PollOutcome{}, nil
		}
		urls := make([]string, 0, len(outputs))
		for _, output := range outputs {
			values := url.Values{}
			values.Set("filename", output.Filename)
			values.Set("subfolder", output.Subfolder)
			values.Set("type", output.Type)
			urls = append(urls, root+"/view?"+values.Encode())
		}
		result, err := c.downloadOutputs(ctx, outputsFromURLs(urls), promptID, nil, &config, root)
		if err != nil {
			return PollOutcome{}, err
		}
		c.updateReceipt(ctx, promptID, "succeeded", nil)
		return PollOutcome{Done: true, Result: result}, nil
	}
	if mode == "video" && c.Poller != nil {
		return c.Poller.Poll(ctx, promptID, defaultVideoPolicy(), query)
	}
	interval := c.Time.LegacyPollInterval()
	for deadline := c.Time.PollDeadline(ctx); c.Time.Now().Before(deadline); {
		out, err := query(ctx)
		if err != nil {
			return nil, err
		}
		if out.Done {
			return out.Result, nil
		}
		if err := c.Time.Sleep(ctx, interval); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("ComfyUI 工作流任务超时（%s）", promptID)
}

// QueryComfyUI checks a previously accepted job without submitting it again.
func (c *Client) QueryComfyUI(ctx context.Context, config Config, requestID, mode string) (map[string]interface{}, string, error) {
	root := comfyUIRootURL(config.BaseURL)
	outputs, stage, err := c.queryComfyHistory(ctx, config, root, strings.TrimSpace(requestID))
	if err != nil || stage != "succeeded" {
		return nil, stage, err
	}
	urls := make([]string, 0, len(outputs))
	for _, output := range outputs {
		values := url.Values{}
		values.Set("filename", output.Filename)
		values.Set("subfolder", output.Subfolder)
		values.Set("type", output.Type)
		urls = append(urls, root+"/view?"+values.Encode())
	}
	result, err := c.downloadOutputs(ctx, outputsFromURLs(urls), requestID, nil, &config, root)
	if err != nil {
		return nil, stage, err
	}
	return result, stage, nil
}

func outputsFromURLs(urls []string) []runningHubOutput {
	outputs := make([]runningHubOutput, len(urls))
	for index, rawURL := range urls {
		outputs[index] = runningHubOutput{URL: rawURL}
	}
	return outputs
}

func (c *Client) queryComfyHistory(ctx context.Context, config Config, root, promptID string) ([]comfyOutputFile, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	endpoint := root + "/history/" + url.PathEscape(promptID)
	response, _, err := c.execute(ctx, Request{Kind: "poll", Method: http.MethodGet, URL: endpoint, Headers: comfyOutboundHeaders(config)})
	if err != nil {
		return nil, "", fmt.Errorf("ComfyUI 查询任务失败：%w", err)
	}
	var history map[string]map[string]interface{}
	if err := json.Unmarshal(response, &history); err != nil {
		return nil, "", errors.New("ComfyUI 历史响应不是有效 JSON")
	}
	entry := history[promptID]
	if entry == nil {
		return nil, "queued", nil
	}
	if status, ok := entry["status"].(map[string]interface{}); ok {
		statusText := strings.ToLower(strings.TrimSpace(stringValue(status["status_str"])))
		if statusText == "error" || statusText == "failed" {
			return nil, "failed", errors.New(comfyExecutionFailureSummary(status["messages"]))
		}
		if status["completed"] == true || statusText == "success" || statusText == "succeeded" {
			outputs := comfyHistoryFiles(entry["outputs"])
			if len(outputs) == 0 {
				return nil, "failed", errors.New("ComfyUI 已执行完成，但没有返回图片、视频或音频文件；请检查媒体输出节点是否通过校验并连接到生成链路")
			}
			return outputs, "succeeded", nil
		}
	}
	return nil, "running", nil
}

func comfyHistoryFiles(value interface{}) []comfyOutputFile {
	nodes, ok := value.(map[string]interface{})
	if !ok {
		return nil
	}
	var files []comfyOutputFile
	for _, raw := range nodes {
		output, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		for _, key := range []string{"images", "gifs", "videos", "audio", "audios"} {
			items, ok := output[key].([]interface{})
			if !ok {
				if item, isMap := output[key].(map[string]interface{}); isMap {
					items = []interface{}{item}
				}
			}
			for _, item := range items {
				metadata, ok := item.(map[string]interface{})
				if !ok {
					continue
				}
				filename := strings.TrimSpace(stringValue(metadata["filename"]))
				if filename == "" || filepath.Base(filename) != filename {
					continue
				}
				outputType := strings.TrimSpace(stringValue(metadata["type"]))
				if outputType == "" {
					outputType = "output"
				}
				files = append(files, comfyOutputFile{Filename: filename, Subfolder: strings.TrimSpace(stringValue(metadata["subfolder"])), Type: outputType})
			}
		}
	}
	return files
}

func comfyOutputMimeType(rawURL, detected string) string {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(detected)), "image/") || strings.HasPrefix(strings.ToLower(strings.TrimSpace(detected)), "video/") || strings.HasPrefix(strings.ToLower(strings.TrimSpace(detected)), "audio/") {
		return detected
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return detected
	}
	filename := parsed.Query().Get("filename")
	extension := strings.ToLower(filepath.Ext(filename))
	if value := mime.TypeByExtension(extension); value != "" {
		return value
	}
	switch extension {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mov":
		return "video/quicktime"
	case ".m4a":
		return "audio/mp4"
	}
	return detected
}
