import React from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router";
import ComfyUISettingsPage from "../../src/pages/settings/comfyui-settings";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import { COMFYUI_PLUGIN_ID } from "../../src/lib/plugins/builtin/workflows";
import { useConfigStore } from "../../src/stores/use-config-store";
import { usePluginStore } from "../../src/stores/use-plugin-store";
import { commitModelConfig, hydrateModelConfig } from "../../src/services/model-config-repository";
import { ModelPicker } from "../../src/components/model-picker";

function ImageModelPreview() {
    const config = useConfigStore((state) => state.config);
    return createPortal(<section aria-label="图片模型验证" style={{ position: "fixed", left: 20, top: 20, zIndex: 1000 }}><ModelPicker config={config} capability="image" value={config.imageModel} onChange={(model) => useConfigStore.getState().updateConfig("imageModel", model)} /></section>, document.body);
}

await useConfigStore.persist.rehydrate();
const restored = await hydrateModelConfig();
useConfigStore.getState().replaceConfig(restored.config);
usePluginStore.getState().setRuntimeStatuses({ [COMFYUI_PLUGIN_ID]: "enabled" });
// Match the workspace subscription so the test exercises explicit saves alongside autosave.
useConfigStore.subscribe((state) => { void commitModelConfig(state.config); });
const dark = new URLSearchParams(location.search).get("theme") === "dark";
createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={getAntThemeConfig(dark)}><App><MemoryRouter><ComfyUISettingsPage /><ImageModelPreview /></MemoryRouter></App></ConfigProvider>,
);
