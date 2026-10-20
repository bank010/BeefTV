package workflow

import "strings"

// Bind only the H3 graph's matching dimension and seconds-to-frames paths;
// unrelated primitive widgets must remain internal.
func applyWorkflowVideoControls(graph map[string]any, fields []map[string]any) {
	selectors := map[string]bool{}
	durations := map[string]bool{}
	for _, raw := range graph {
		node, _ := raw.(map[string]any)
		if node["class_type"] != "MiniMaxH3ReferenceToVideo" {
			continue
		}
		inputs, _ := node["inputs"].(map[string]any)
		width := workflowLinkedNodeID(inputs["width"], 0)
		if width != "" && width == workflowLinkedNodeID(inputs["height"], 1) {
			selector, _ := graph[width].(map[string]any)
			if selector["class_type"] == "ResolutionSelector" {
				selectors[width] = true
			}
		}
		mathNode, _ := graph[workflowLinkedNodeID(inputs["length"], 1)].(map[string]any)
		if mathNode["class_type"] != "ComfyMathExpression" {
			continue
		}
		mathInputs, _ := mathNode["inputs"].(map[string]any)
		expression := strings.Join(strings.Fields(stringValue(mathInputs["expression"])), "")
		if expression != "max(5,round(a*24))+(5-(max(5,round(a*24))%17))%17" {
			continue
		}
		id := workflowLinkedNodeID(mathInputs["values.a"], 0)
		primitive, _ := graph[id].(map[string]any)
		if primitive["class_type"] == "PrimitiveFloat" {
			durations[id] = true
		}
	}
	for _, field := range fields {
		id := stringValue(field["nodeId"])
		source := ""
		switch {
		case selectors[id] && field["fieldName"] == "aspect_ratio":
			source = "aspectRatio"
			field["options"] = workflowFieldAllowedOptions(Field{ClassType: "ResolutionSelector", FieldName: "aspect_ratio"})
		case selectors[id] && field["fieldName"] == "megapixels":
			source = "vquality"
			// ResolutionSelector INPUT_TYPES uses target megapixels, not pixels.
			field["min"], field["max"], field["step"] = 0.1, 16.0, 0.1
		case durations[id] && field["fieldName"] == "value":
			source = "videoSeconds"
			field["min"], field["max"], field["step"] = 1, comfyMaxH3Seconds, 1
		}
		if source != "" {
			field["source"], field["sourceAutomatic"] = source, true
			field["role"], field["enabled"] = "business", true
		}
	}
}

func workflowLinkedNodeID(value any, slot int) string {
	link, ok := value.([]any)
	if !ok || len(link) != 2 || managementIntValue(link[1], -1) != slot {
		return ""
	}
	return stringValue(link[0])
}
