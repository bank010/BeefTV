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
	fields := workflowFieldsForMode(input.Config.WorkflowFields, input.Mode)
	if len(fields) == 0 {
		fields, err = workflowFieldsFromManagement(graph, input.Mode)
		if err != nil {
			return nil, err
		}
	}
	if err := validateWorkflowMediaInputs(fields, input); err != nil {
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
	body, err := json.Marshal(map[string]interface{}{"prompt": graph})
	if err != nil {
		return nil, fmt.Errorf("ComfyUI 工作流编码失败：%w", err)
	}
	response, _, err := c.execute(ctx, Request{
		Kind:        "create",
		Method:      http.MethodPost,
		URL:         root + "/prompt",
		Headers:     comfyOutboundHeaders(input.Config),
		ContentType: "application/json",
		Body:        body,
	})
	if err != nil {
		return nil, CreateUncertain{Err: fmt.Errorf("ComfyUI 工作流提交失败：%w", err)}
	}
	var submitted map[string]interface{}
	if err := json.Unmarshal(response, &submitted); err != nil {
		return nil, CreateUncertain{Err: errors.New("ComfyUI 提交响应不是有效 JSON")}
	}
	promptID := strings.TrimSpace(stringValue(submitted["prompt_id"]))
	if promptID == "" {
		if detail := comfyNodeValidationSummary(submitted["node_errors"]); detail != "" {
			return nil, fmt.Errorf("ComfyUI 工作流节点校验失败：%s", detail)
		}
		return nil, CreateUncertain{Err: errors.New("ComfyUI 未返回 prompt_id")}
	}
	if err := c.Receipt.RecordAccepted(ctx, promptID, "submitted", nil); err != nil {
		c.Progress.Log(ctx, "error", "ComfyUI 请求状态保存失败", promptID+"："+err.Error())
		return nil, AcceptedNotRecorded{RequestID: promptID, Stage: "submitted", Err: err}
	}
	// HTTP 200 and prompt_id can accept only the valid output branches. Keep the
	// receipt before reporting validation errors so retries cannot lose that job.
	if detail := comfyNodeValidationSummary(submitted["node_errors"]); detail != "" {
		return nil, fmt.Errorf("ComfyUI 部分输出节点校验失败，已保留上游任务 ID；请修正工作流后再生成：%s", detail)
	}
	return c.pollComfyUI(ctx, input.Config, root, promptID, input.Mode)
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
			switch workflowScalarString(entry["type"]) {
			case "value_not_in_list":
				reason = "参数不在允许选项中"
			case "required_input_missing":
				reason = "缺少必需输入"
			case "invalid_input_type", "return_type_mismatch":
				reason = "输入类型不匹配"
			}
			extra, _ := entry["extra_info"].(map[string]any)
			if field := workflowScalarString(extra["input_name"]); comfyDiagnosticIdentifier.MatchString(field) {
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
			return nil, "failed", nil
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
