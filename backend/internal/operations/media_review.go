package operations

import (
	"context"
	"encoding/json"
	"strings"
)

// MediaReviewer performs one bounded inference over bytes already authorized by
// the media operation. It has no tools, project writes, or recovery loop.
type MediaReviewer interface {
	ReviewMedia(context.Context, MediaPart, string) (MediaReviewObservation, error)
}

type MediaReviewObservation struct {
	Model     string          `json:"model"`
	RequestID string          `json:"requestId,omitempty"`
	Text      string          `json:"observations"`
	Usage     json.RawMessage `json:"usage,omitempty"`
}

type mediaReviewArgs struct {
	CanvasID        string `json:"canvasId"`
	NodeID          string `json:"nodeId,omitempty"`
	AssetID         string `json:"assetId,omitempty"`
	ExpectedVersion string `json:"expectedVersion"`
	StartMs         int64  `json:"startMs"`
	EndMs           int64  `json:"endMs"`
	Question        string `json:"question"`
}

func registerMediaReview(r *Registry) {
	r.Register(Op{ID: "media.review", AssistantCanvas: true, ReadOnly: true, ReplayUnsafe: true, Scope: ScopeCanvas,
		Summary: "用单独配置的多模态审片模型检查已关联视频的指定区间（最多15秒，包含原音轨），返回观察和用量，可能收费。先用media.overview取得版本。问题应来自用户要求，不预填正确答案或已知缺陷。结果是模型观察，不是整片合格证明；失败或中断不自动重发。未配置时明确不可用。",
		Params:  json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"canvasId":{"type":"string"},"nodeId":{"type":"string"},"assetId":{"type":"string"},"expectedVersion":{"type":"string","minLength":1},"startMs":{"type":"integer","minimum":0},"endMs":{"type":"integer","minimum":1},"question":{"type":"string","minLength":1,"maxLength":4000}},"required":["canvasId","expectedVersion","startMs","endMs","question"]}`), Handler: runMediaReview})
}

func runMediaReview(ctx *Context, raw json.RawMessage) (any, error) {
	var args mediaReviewArgs
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Question) == "" || len([]rune(args.Question)) > 4000 || args.StartMs < 0 || args.EndMs <= args.StartMs || args.EndMs-args.StartMs > 15000 || strings.TrimSpace(args.ExpectedVersion) == "" {
		return nil, InvalidArg("invalid_media_review", "请提供素材版本、明确的15秒以内区间和审查问题")
	}
	reviewer, ok := ctx.Domain.(MediaReviewer)
	if !ok {
		return nil, Unsupported("media_review_unavailable", "当前工作区未配置审片模型")
	}
	params, _ := json.Marshal(mediaArgs{CanvasID: args.CanvasID, NodeID: args.NodeID, AssetID: args.AssetID, ExpectedVersion: args.ExpectedVersion, StartMs: args.StartMs, EndMs: args.EndMs, Mode: "video"})
	value, err := runMedia(ctx, "media.inspect", params)
	if err != nil {
		return nil, err
	}
	media := value.(MediaResult)
	if len(media.Content) != 1 || media.Content[0].MimeType != "video/mp4" {
		return nil, InvalidArg("media_review_requires_video", "审片工具需要视频素材")
	}
	part := media.Content[0]
	observation, err := reviewer.ReviewMedia(ctx.Context, part, args.Question)
	if err != nil {
		return nil, err
	}
	return map[string]any{"source": media.Source, "durationMs": media.DurationMs, "hasAudio": media.HasAudio, "mediaSHA256": part.SHA256, "review": observation, "note": "指定片段已交给审片模型；观察可能有遗漏，需与原始要求及可见画面对照。时间位置以截取片段起点为0，加上source.startMs后才是原素材位置。"}, nil
}
