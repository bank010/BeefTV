package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestComfyReferenceRunUploadsAllMediaBeforeSubmitting(t *testing.T) {
	for _, withSource := range []bool{false, true} {
		t.Run(fmt.Sprintf("source=%v", withSource), func(t *testing.T) {
			source := omniReferenceFixture()
			cached, err := comfySavedWorkflowToAPI(source)
			if err != nil {
				t.Fatal(err)
			}
			input := Input{Mode: "video", Config: Config{InterfaceType: "comfyui-workflow-video", BaseURL: allowLocalComfyUI(t), WorkflowID: "workflows/test.json", WorkflowJSON: cached}}
			if withSource {
				input.Config.SourceWorkflowJSON = source
			}
			for kind, destination := range []*[]Media{&input.ReferenceImages, &input.ReferenceVideos, &input.ReferenceAudios} {
				for i := 0; i < []int{9, 3, 3}[kind]; i++ {
					*destination = append(*destination, Media{ID: fmt.Sprintf("%d-%d", kind, i), DataURL: "data:application/octet-stream;base64,AAAA"})
				}
			}
			uploads, reads, submissions := 0, 0, 0
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				switch {
				case strings.Contains(req.URL, "/api/userdata/"):
					reads++
					body, _ := json.Marshal(source)
					return body, "application/json", nil
				case strings.HasSuffix(req.URL, "/upload/image"):
					uploads++
					return []byte(fmt.Sprintf(`{"name":"uploaded-%d"}`, uploads)), "application/json", nil
				case strings.HasSuffix(req.URL, "/prompt"):
					submissions++
					var body struct {
						Prompt map[string]any `json:"prompt"`
					}
					if err := json.Unmarshal(req.Body, &body); err != nil {
						t.Fatal(err)
					}
					target := body.Prompt["160"].(map[string]any)["inputs"].(map[string]any)
					if uploads != 15 || len(target) != 15 {
						t.Fatalf("submitted %d slots after %d uploads", len(target), uploads)
					}
					for _, value := range target {
						link := value.([]any)
						loader := body.Prompt[fmt.Sprint(link[0])].(map[string]any)["inputs"].(map[string]any)
						bound := false
						for _, name := range []string{"image", "video", "audio"} {
							bound = bound || strings.HasPrefix(workflowScalarString(loader[name]), "uploaded-")
						}
						if !bound {
							t.Fatal("default media survived submission")
						}
					}
					return nil, "", errors.New("stop at simulated submission")
				default:
					t.Fatalf("unexpected request: %s", req.URL)
					return nil, "", nil
				}
			}}
			_, err = comfyTestClient(exec, &memoryReceipt{}).Run(context.Background(), input)
			if err == nil || submissions != 1 || (withSource && reads != 0) || (!withSource && reads != 1) {
				t.Fatalf("err=%v, reads=%d, submissions=%d", err, reads, submissions)
			}
		})
	}
}

func omniReferenceFixture() map[string]any {
	nodes := []any{}
	links := []any{}
	inputs := []any{}
	for _, spec := range []struct {
		kind, class, widget, output string
		ids                         []int
	}{
		{"image", "LoadImage", "image", "IMAGE", []int{161, 164, 169, 162, 163, 167, 165, 166, 168}},
		{"video", "VHS_LoadVideo", "video", "IMAGE", []int{170, 171, 172}},
		{"audio", "LoadAudio", "audio", "AUDIO", []int{173, 174, 175}},
	} {
		for index, id := range spec.ids {
			linkID := len(links) + 1
			var widgets any = []any{"old-file"}
			if spec.kind == "video" {
				widgets = map[string]any{"video": "old-video", "videopreview": map[string]any{}}
			}
			nodes = append(nodes, map[string]any{
				"id": id, "type": spec.class, "mode": 4,
				"inputs":  []any{map[string]any{"name": spec.widget, "widget": map[string]any{"name": spec.widget}}},
				"outputs": []any{map[string]any{"type": spec.output}}, "widgets_values": widgets,
			})
			inputs = append(inputs, map[string]any{"name": fmt.Sprintf("ref_%ss.ref_%s_%d", spec.kind, spec.kind, index), "link": linkID})
			links = append(links, []any{linkID, id, 0, 160, len(inputs) - 1, spec.output})
		}
	}
	nodes = append(nodes, map[string]any{"id": 160, "type": "MiniMaxH3ReferenceToVideo", "inputs": inputs})
	return map[string]any{"nodes": nodes, "links": links}
}

func TestComfyReferenceSlotsPreserveCapacityOrderAndUnusedBranches(t *testing.T) {
	source := omniReferenceFixture()
	full := Input{Mode: "video", ReferenceImages: make([]Media, 9), ReferenceVideos: make([]Media, 3), ReferenceAudios: make([]Media, 3)}
	all, err := comfySavedWorkflowToAPIForInput(source, full)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := workflowFieldsFromManagement(all, "video")
	if err != nil {
		t.Fatal(err)
	}
	for _, counts := range [][3]int{{9, 3, 3}, {1, 1, 0}, {2, 0, 0}, {0, 3, 3}, {0, 0, 0}} {
		t.Run(fmt.Sprint(counts), func(t *testing.T) {
			input := Input{Mode: "video"}
			files := map[string]string{}
			for kind, destination := range []*[]Media{&input.ReferenceImages, &input.ReferenceVideos, &input.ReferenceAudios} {
				for index := 0; index < counts[kind]; index++ {
					id := fmt.Sprintf("media-%d-%d", kind, index)
					*destination = append(*destination, Media{ID: id})
					files[id] = id + ".uploaded"
				}
			}
			graph, err := comfySavedWorkflowToAPIForInput(source, input)
			if err != nil {
				t.Fatal(err)
			}
			fields, err := ensureWorkflowFieldsForMediaInputs(comfyExecutionFields(saved, graph), graph, "video", input)
			if err != nil {
				t.Fatal(err)
			}
			if err := applyComfyWorkflowFields(graph, fields, files, input); err != nil {
				t.Fatal(err)
			}
			target := graph["160"].(map[string]any)["inputs"].(map[string]any)
			if len(target) != counts[0]+counts[1]+counts[2] || len(graph) != len(target)+1 {
				t.Fatalf("unused loaders survived: %d slots, %d nodes", len(target), len(graph))
			}
			for kindIndex, kind := range []string{"image", "video", "audio"} {
				for index := 0; index < counts[kindIndex]; index++ {
					link := target[fmt.Sprintf("ref_%ss.ref_%s_%d", kind, kind, index)].([]any)
					loader := graph[fmt.Sprint(link[0])].(map[string]any)["inputs"].(map[string]any)
					if got, want := loader[kind], fmt.Sprintf("media-%d-%d.uploaded", kindIndex, index); got != want {
						t.Fatalf("%s slot %d got %v, want %s", kind, index, got, want)
					}
				}
			}
		})
	}
	if source["nodes"].([]any)[0].(map[string]any)["mode"] != 4 {
		t.Fatal("preparation mutated saved workflow")
	}
}
