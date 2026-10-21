package canvas

import (
	"math"
	"testing"
)

func TestBoundVideoFrameFollowsMeasuredPortraitSize(t *testing.T) {
	node := map[string]any{
		"type": "video", "width": 720.0, "height": 405.0,
		"position": map[string]any{"x": 100.0, "y": 200.0},
		"metadata": map[string]any{},
	}
	patch := TaskOutputBind{MediaType: "video", Width: 736, Height: 1280}
	if !alignBoundVideoGeometry(node, patch) {
		t.Fatal("portrait result kept landscape frame")
	}
	w, h := node["width"].(float64), node["height"].(float64)
	pos := node["position"].(map[string]any)
	if math.Abs(w/h-736.0/1280) > 1e-9 || math.Abs(pos["x"].(float64)+w/2-460) > 1e-9 || math.Abs(pos["y"].(float64)+h/2-402.5) > 1e-9 {
		t.Fatalf("geometry changed center or aspect: %#v", node)
	}
	if alignBoundVideoGeometry(node, patch) {
		t.Fatal("replay changed correct geometry")
	}
	for _, flag := range []string{"locked", "freeResize"} {
		manual := map[string]any{"width": 720.0, "height": 405.0, "metadata": map[string]any{flag: true}}
		if alignBoundVideoGeometry(manual, patch) {
			t.Fatalf("overwrote %s layout", flag)
		}
	}
}
