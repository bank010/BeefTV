package operations

import (
	"encoding/json"
	"testing"
)

type mixedGenerationProbe struct {
	proposeProbe
	admitted []GenerationTarget
}

func (p *mixedGenerationProbe) SubmitAuthorizedGeneration(_, _, _ string, targets []GenerationTarget) (any, error) {
	p.admitted = targets
	return map[string]any{"taskIds": []string{"video-task", "voice-task"}}, nil
}

func TestGenerationSubmitMixedReadyTargetsAndDependencyRejection(t *testing.T) {
	for _, pending := range []bool{false, true} {
		t.Run(map[bool]string{false: "ready", true: "pending-reference"}[pending], func(t *testing.T) {
			frame := imageNode("frame", "image")
			if !pending {
				frame["metadata"].(map[string]any)["storageKey"] = "resource:frame"
			}
			video := imageNode("video", "video")
			video["type"] = "video"
			video["metadata"].(map[string]any)["videoStartFrameNodeId"] = "frame"
			voice := imageNode("voice", "speech")
			voice["type"] = "audio"
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{frame, video, voice})}}
			p.resolve = func(kind, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{ModelKey: selected}, nil
			}
			_, err := opGenerationSubmit(&Context{TurnID: "turn", UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeIds":["video","voice"]}`))
			if pending {
				if err == nil || len(p.admitted) != 0 {
					t.Fatal("unready dependency admitted paid work", err)
				}
			} else if err != nil || len(p.admitted) != 2 || p.admitted[0].Kind != "video" || p.admitted[1].Kind != "audio" {
				t.Fatalf("mixed admission: %+v %v", p.admitted, err)
			}
		})
	}
}
