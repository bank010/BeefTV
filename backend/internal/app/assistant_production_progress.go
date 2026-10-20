package app

import (
	"encoding/json"
	"reflect"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"
)

// The existing continuation receipt advances the exact confirmed inputs. Model
// admission waits until their files are saved; this does not create a new queue
// or retry failed/unknown purchases. Called under the claim's scope transaction.
func (s *Service) prepareAssistantProduction(tx *gorm.DB, receipt *model.AssistantContinuation) (bool, error) {
	var source model.AssistantTurn
	if err := tx.First(&source, "turn_id = ? AND user_id = ?", receipt.SourceTurnID, receipt.UserID).Error; err != nil {
		return false, err
	}
	if source.GenerationAuthorizationJSON == "" {
		return true, nil
	}
	var plan operations.GenerationAuthorization
	if err := json.Unmarshal([]byte(source.GenerationAuthorizationJSON), &plan); err != nil {
		return false, err
	}
	if source.Undone || source.ContinuationInvalidated || plan.SourceTurnID != source.TurnID || plan.ProposalID != receipt.ProposalID {
		return false, operations.PreconditionFailed("production_revoked", "本次制作授权已停止", nil)
	}
	domain := s.BindDomain(tx).(*operationSession)
	raw, err := domain.UserCanvasProject(receipt.UserID, receipt.CanvasID)
	if err != nil {
		return false, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return false, err
	}
	nodes := map[string]map[string]any{}
	for _, value := range doc["nodes"].([]any) {
		node := value.(map[string]any)
		nodes[node["id"].(string)] = node
	}
	ids := make([]string, 0, len(plan.Targets))
	for _, target := range plan.Targets {
		ids = append(ids, target.NodeID)
	}
	current, err := operations.GenerationTargets(domain, doc, ids)
	if err != nil {
		return false, err
	}
	if !reflect.DeepEqual(current, plan.Targets) {
		return false, &assistantturns.Error{Reason: "continuation_intent_changed", Message: "制作方案已修改，自动制作已停止，请确认新的方案"}
	}
	saved, planned := map[string]bool{}, map[string]bool{}
	pending := []operations.GenerationTarget{}
	allSaved := true
	failed, running := false, false
	for _, target := range plan.Targets {
		planned[target.NodeID] = true
		task, err := domain.repo.TaskByClientOperation(receipt.UserID, productionTaskKey(plan, target.NodeID))
		if err != nil {
			return false, err
		}
		if task == nil {
			pending = append(pending, target)
			allSaved = false
			continue
		}
		if err := validateProductionTask(task, receipt.CanvasID, target); err != nil {
			return false, err
		}
		if task.Status == model.TaskStatusFailed || task.Status == model.TaskStatusCancelled {
			failed = true
			continue
		}
		running = running || task.Status != model.TaskStatusSucceeded
		meta, _ := nodes[target.NodeID]["metadata"].(map[string]any)
		saved[target.NodeID], err = productionTargetSaved(tx, receipt.UserID, target, task, meta)
		if err != nil {
			return false, err
		}
		allSaved = allSaved && saved[target.NodeID]
	}
	if failed {
		// Keep the single wake until every already-admitted sibling settles.
		// Do not admit pending dependants or repurchase a failed task.
		return !running, nil
	}
	if allSaved {
		return true, nil
	}
	ready := []operations.GenerationTarget{}
	for _, target := range pending {
		dependenciesSaved := true
		for _, id := range target.ReferenceNodeIDs {
			if planned[id] && !saved[id] {
				dependenciesSaved = false
			}
		}
		if dependenciesSaved {
			ready = append(ready, target)
		}
	}
	if len(ready) == 0 {
		return false, nil
	}
	_, err = domain.admitProductionTargets(receipt.UserID, receipt.CanvasID, plan, ready)
	return false, err
}

func productionTargetSaved(tx *gorm.DB, userID string, target operations.GenerationTarget, task *model.Task, meta map[string]any) (bool, error) {
	key, _ := meta["storageKey"].(string)
	if task.Status != model.TaskStatusSucceeded || meta["taskId"] != task.ID || meta["status"] != "success" || meta["resourceReloadAvailable"] == true || !strings.HasPrefix(key, "resource:") {
		return false, nil
	}
	var records []model.Result
	if err := tx.Where("task_id = ? AND user_id = ? AND kind = ?", task.ID, userID, localtask.ResultKindGenerationOutput).Find(&records).Error; err != nil {
		return false, err
	}
	outputs, err := localtask.DecodeOutputResults(records)
	if err != nil {
		return false, err
	}
	for _, output := range outputs {
		if output.OutputIndex != 0 || output.ResourceID == "" || output.MaterializationErrorCode != "" || output.MediaType != target.Kind || output.TargetBinding == nil || output.TargetBinding.NodeID != target.NodeID || key != "resource:"+output.ResourceID {
			continue
		}
		var count int64
		err := tx.Model(&model.Resource{}).Where("id = ? AND user_id = ? AND status = ?", output.ResourceID, userID, model.ResourceStatusReady).Count(&count).Error
		return count == 1, err
	}
	return false, nil
}
