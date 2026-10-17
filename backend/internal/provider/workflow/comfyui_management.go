package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
)

const comfyMaxWorkflowFileBytes = 8 << 20

// FetchComfyUIUserData lists one directory under ComfyUI's user workflow tree.
func (c *Client) FetchComfyUIUserData(ctx context.Context, config Config, directory string) ([]map[string]any, error) {
	directory, err := cleanComfyWorkflowPath(directory, false)
	if err != nil {
		return nil, err
	}
	query := url.Values{}
	query.Set("dir", directory)
	response, _, err := c.execute(ctx, Request{
		Kind:    "workflow-schema",
		Method:  http.MethodGet,
		URL:     comfyUIRootURL(config.BaseURL) + "/api/userdata?" + query.Encode(),
		Headers: comfyOutboundHeaders(config),
	})
	if err != nil {
		return nil, fmt.Errorf("读取 ComfyUI 工作流目录失败：%w", err)
	}
	if len(response) > comfyMaxWorkflowFileBytes {
		return nil, errors.New("ComfyUI 工作流目录响应过大")
	}
	var paths []string
	if err := json.Unmarshal(response, &paths); err == nil {
		files := make([]map[string]any, 0, len(paths))
		for _, filePath := range paths {
			files = append(files, map[string]any{"name": filePath, "type": "file"})
		}
		return files, nil
	}
	var files []map[string]any
	if err := json.Unmarshal(response, &files); err == nil {
		return files, nil
	}
	var wrapped struct {
		Files []map[string]any `json:"files"`
	}
	if err := json.Unmarshal(response, &wrapped); err != nil {
		return nil, errors.New("ComfyUI 工作流目录响应格式无效")
	}
	return wrapped.Files, nil
}

// FetchComfyUIWorkflow loads one JSON workflow file from ComfyUI user data.
func (c *Client) FetchComfyUIWorkflow(ctx context.Context, config Config, file string) (map[string]any, error) {
	file, err := cleanComfyWorkflowPath(file, true)
	if err != nil {
		return nil, err
	}
	response, _, err := c.execute(ctx, Request{
		Kind:    "workflow-schema",
		Method:  http.MethodGet,
		URL:     comfyUIRootURL(config.BaseURL) + "/api/userdata/" + url.PathEscape(file),
		Headers: comfyOutboundHeaders(config),
	})
	if err != nil {
		return nil, fmt.Errorf("读取 ComfyUI 工作流失败：%w", err)
	}
	if len(response) == 0 || len(response) > comfyMaxWorkflowFileBytes {
		return nil, errors.New("ComfyUI 工作流文件为空或超过 8MB")
	}
	var workflow map[string]any
	if err := json.Unmarshal(response, &workflow); err != nil || len(workflow) == 0 {
		return nil, errors.New("ComfyUI 工作流文件不是有效 JSON 对象")
	}
	apiWorkflow, err := comfySavedWorkflowToAPI(workflow)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"workflowJson":       apiWorkflow,
		"sourceWorkflowJson": workflow,
	}, nil
}

func comfySavedWorkflowToAPI(saved map[string]any) (map[string]any, error) {
	if isComfyAPIWorkflow(saved) {
		return cloneComfyWorkflow(saved)
	}
	nodes, ok := saved["nodes"].([]any)
	if !ok || len(nodes) == 0 || len(nodes) > 500 {
		return nil, errors.New("ComfyUI 工作流必须包含 1 到 500 个节点")
	}
	links := make(map[string][]any)
	if rawLinks, ok := saved["links"].([]any); ok {
		for _, raw := range rawLinks {
			link, ok := raw.([]any)
			if !ok || len(link) < 5 {
				continue
			}
			links[fmt.Sprint(link[0])] = link
		}
	}
	nodesByID := make(map[string]map[string]any, len(nodes))
	for _, raw := range nodes {
		node, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("ComfyUI 工作流包含无效节点")
		}
		id := workflowScalarString(node["id"])
		if id == "" || nodesByID[id] != nil {
			return nil, errors.New("ComfyUI 工作流节点 ID 缺失或重复")
		}
		nodesByID[id] = node
	}
	graph := make(map[string]any, len(nodes))
	for _, raw := range nodes {
		node, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("ComfyUI 工作流包含无效节点")
		}
		id := strings.TrimSpace(fmt.Sprint(node["id"]))
		classType := strings.TrimSpace(fmt.Sprint(node["type"]))
		if id == "" || id == "<nil>" || classType == "" || classType == "<nil>" {
			return nil, errors.New("ComfyUI 工作流节点缺少 id 或 type")
		}
		if _, duplicate := graph[id]; duplicate {
			return nil, fmt.Errorf("ComfyUI 工作流节点 ID 重复：%s", id)
		}
		if mode := managementIntValue(node["mode"], 0); mode == 2 || mode == 4 {
			continue
		}
		inputs := make(map[string]any)
		uiInputs, _ := node["inputs"].([]any)
		widgetValues, _ := node["widgets_values"].([]any)
		widgetIndex := 0
		for _, rawInput := range uiInputs {
			input, ok := rawInput.(map[string]any)
			if !ok {
				continue
			}
			name := strings.TrimSpace(fmt.Sprint(input["name"]))
			if name == "" || name == "<nil>" {
				continue
			}
			widgetValueIndex := -1
			if input["widget"] != nil {
				widgetValueIndex = widgetIndex
				widgetIndex++
				// ComfyUI serializes seed control_after_generate beside the seed,
				// but that UI-only widget is absent from the API input list.
				if isManagementSeedField(name) && widgetIndex < len(widgetValues) {
					switch workflowScalarString(widgetValues[widgetIndex]) {
					case "fixed", "increment", "decrement", "randomize":
						widgetIndex++
					}
				}
			}
			if linkID := input["link"]; linkID != nil {
				link, err := comfySavedInputLink(linkID, nodesByID, links, make(map[string]bool))
				if err != nil {
					return nil, fmt.Errorf("ComfyUI 工作流节点 %s 的输入 %s：%w", id, name, err)
				}
				if link != nil {
					inputs[name] = link
				}
				continue
			}
			if widgetValueIndex >= 0 {
				if widgetValueIndex < len(widgetValues) {
					inputs[name] = widgetValues[widgetValueIndex]
				}
				continue
			}
		}
		graph[id] = comfyAPIWorkflowNode(classType, inputs, strings.TrimSpace(workflowScalarString(node["title"])))
	}
	return cloneComfyWorkflow(graph)
}

// Bypassed nodes forward a matching connected input; muted nodes contribute no
// input. Ambiguous custom routing must be exported by ComfyUI as an API graph.
func comfySavedInputLink(linkID any, nodes map[string]map[string]any, links map[string][]any, visiting map[string]bool) ([]any, error) {
	key := workflowScalarString(linkID)
	link, ok := links[key]
	if !ok || visiting[key] {
		return nil, errors.New("连线不存在或旁路形成循环")
	}
	visiting[key] = true
	nodeID := workflowScalarString(link[1])
	node := nodes[nodeID]
	if node == nil {
		return nil, errors.New("连线来源节点不存在")
	}
	switch managementIntValue(node["mode"], 0) {
	case 2:
		return nil, nil
	case 4:
		outputs, _ := node["outputs"].([]any)
		slot := managementIntValue(link[2], -1)
		if slot < 0 || slot >= len(outputs) {
			return nil, errors.New("无法确定旁路输出，请在 ComfyUI 中导出 API 格式工作流")
		}
		output, _ := outputs[slot].(map[string]any)
		outputType := workflowScalarString(output["type"])
		inputs, _ := node["inputs"].([]any)
		var candidates []any
		for _, raw := range inputs {
			input, _ := raw.(map[string]any)
			if input["link"] != nil && outputType != "" && workflowScalarString(input["type"]) == outputType {
				candidates = append(candidates, input["link"])
			}
		}
		if len(candidates) != 1 {
			return nil, errors.New("无法唯一确定旁路输入，请在 ComfyUI 中导出 API 格式工作流")
		}
		return comfySavedInputLink(candidates[0], nodes, links, visiting)
	default:
		return []any{nodeID, link[2]}, nil
	}
}

// comfyAPIWorkflowNode keeps the UI node title in _meta so the settings page can
// label fields with a human-readable name instead of a bare class_type.
func comfyAPIWorkflowNode(classType string, inputs map[string]any, title string) map[string]any {
	node := map[string]any{"class_type": classType, "inputs": inputs}
	if title != "" && title != classType {
		node["_meta"] = map[string]any{"title": title}
	}
	return node
}

func isComfyAPIWorkflow(value map[string]any) bool {
	if len(value) == 0 {
		return false
	}
	for _, raw := range value {
		node, ok := raw.(map[string]any)
		if !ok || strings.TrimSpace(fmt.Sprint(node["class_type"])) == "" || node["class_type"] == nil {
			return false
		}
		if _, ok := node["inputs"].(map[string]any); !ok {
			return false
		}
	}
	return true
}

func cleanComfyWorkflowPath(value string, file bool) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if value == "" || len(value) > 512 || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "?#%") {
		return "", errors.New("ComfyUI 工作流路径无效")
	}
	cleaned := path.Clean(value)
	if cleaned != value || (cleaned != "workflows" && !strings.HasPrefix(cleaned, "workflows/")) {
		return "", errors.New("ComfyUI 工作流路径必须位于 workflows 目录下")
	}
	if file && (!strings.HasPrefix(cleaned, "workflows/") || !strings.HasSuffix(strings.ToLower(cleaned), ".json")) {
		return "", errors.New("ComfyUI 工作流文件必须是 workflows 下的 JSON 文件")
	}
	return cleaned, nil
}
