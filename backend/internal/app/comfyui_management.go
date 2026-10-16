package app

import (
	"context"
	"path"
	"strings"

	"infinite-canvas/backend/internal/provider/workflow"
)

func (s *Service) FetchComfyUIUserData(ctx context.Context, req ComfyUIUserDataRequest) ([]map[string]any, error) {
	config, err := comfyUIManagementConfig(req)
	if err != nil {
		return nil, err
	}
	directory := strings.TrimSpace(req.Directory)
	if directory == "" {
		directory = "workflows"
	}
	return s.workflowClient(nil).FetchComfyUIUserData(ctx, workflowConfigFromProvider(config), directory)
}

func (s *Service) FetchComfyUIWorkflow(ctx context.Context, req ComfyUIUserDataRequest) (map[string]any, error) {
	config, err := comfyUIManagementConfig(req)
	if err != nil {
		return nil, err
	}
	fetched, err := s.workflowClient(nil).FetchComfyUIWorkflow(ctx, workflowConfigFromProvider(config), strings.TrimSpace(req.File))
	if err != nil {
		return nil, err
	}
	workflowJSON, _ := fetched["workflowJson"].(map[string]any)
	if workflowJSON == nil {
		return nil, BadAuthRequest("ComfyUI 工作流转换失败")
	}
	capability := strings.ToLower(strings.TrimSpace(req.Capability))
	if capability != "image" && capability != "video" && capability != "audio" {
		capability = "image"
	}
	name := path.Base(strings.TrimSpace(req.File))
	title := strings.TrimSuffix(name, path.Ext(name))
	return map[string]any{
		"workflowId":         strings.TrimSpace(req.File),
		"title":              title,
		"capability":         capability,
		"workflowJson":       workflowJSON,
		"sourceWorkflowJson": fetched["sourceWorkflowJson"],
		"fields":             workflow.CollectFields(workflowJSON, capability),
	}, nil
}

func comfyUIManagementConfig(req ComfyUIUserDataRequest) (providerConfig, error) {
	config := providerConfig{BaseURL: strings.TrimSpace(req.BaseURL), APIKey: strings.TrimSpace(req.APIKey)}
	if config.BaseURL == "" {
		return config, BadAuthRequest("请先填写 ComfyUI Base URL")
	}
	if _, err := ValidateOutboundURL(strings.TrimRight(config.BaseURL, "/")); err != nil {
		return config, err
	}
	return config, nil
}
