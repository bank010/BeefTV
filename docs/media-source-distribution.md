# 媒体组件的许可与源码交付

BeefTV 保留现有 FFmpeg 媒体能力。根目录 `LICENSE` 中的新源码可用条款仅适用于其约定的新增原创内容；历史 MIT 内容及第三方组件继续适用原许可证。不能用一条额外声明覆盖第三方许可证。

## 组件与调用方式

| 组件 | 版本与许可 | 使用方式 |
| --- | --- | --- |
| 浏览器 `@ffmpeg/core` | 0.12.10，GPL-2.0-or-later | Worker 中运行，提供剪辑、裁剪、合并、音频处理及导出 |
| Windows FFmpeg/ffprobe | Gyan 8.0.1 essentials，GPL-3.0-or-later | 独立命令行进程，通过参数和文件交换数据 |
| macOS ffprobe | FFmpeg 8.0.1，LGPL-2.1-or-later | 从固定源码编译，关闭 GPL 特性与外部库，独立进程探测媒体 |
| Windows 可选深度运行包 | 主 FFmpeg/ffprobe，以及 imageio-ffmpeg wheel 内的另一个 FFmpeg | Python 启动独立进程；wheel 自带二进制需单独核对 |

原生命令行工具和浏览器 WASM 的使用方式不同，需要分别判断组合分发的许可要求。独立进程、Worker 或单独下载均不能自动证明兼容；第三方清单也不能替代对应源码交付。

## 已实现的交付

- 应用版本号 → 更新日志 → **第三方许可与源码**，可查看项目许可、第三方清单和 GPL/LGPL 全文。
- Web 构建将这些文件写入 `/licenses/`；桌面包同时放在 `agent-host/licenses/`，macOS 位于应用的 `Contents/Resources/` 下，可离线读取。
- `sources.json` 记录本次构建的平台、组件版本、许可和 WASM 文件哈希。`upstream` 是上游项目入口；`source` 仅记录本流水线实际生成的源码包，缺失时为 `null`，页面不生成不存在的下载链接。
- macOS 构建 ffprobe 时同时生成 `BeefTV-vX.Y.Z-ffprobe-darwin-{arm64,amd64}-sources.tar.gz`，包含未经修改的源码、许可证、实际构建脚本、参数和二进制哈希。正式桌面流水线将它与安装包一同上传到同版本 GitHub Release。

可单独生成 macOS 源码包：

```sh
bash scripts/package-media-runtime-macos.sh darwin/arm64 ./media-runtime \
  ./ffmpeg-source.tar.gz ./BeefTV-vX.Y.Z-ffprobe-darwin-arm64-sources.tar.gz
```

这里记录哈希用于核对材料，不将工程校验等同于法律兼容性结论。

## 发布责任

分发者应保留各组件的署名、许可和适用的源码材料，并提供与所分发二进制对应的源码、修改和必要构建脚本。上游主页或版本号本身不构成完整对应源码的交付。

Windows 预构建工具、imageio wheel 内嵌 FFmpeg 和浏览器 WASM 的完整对应源码交付及组合兼容性不由本次许可入口改动证明。发版时仍需逐项落实，不能以本次合并视为全部完成。具体未决材料与验证证据保留在 PR #205；本改动不替换编码器，也不改变既有发布门禁。

## 参考

- [FFmpeg 许可说明](https://ffmpeg.org/legal.html)
- [ffmpeg.wasm 官方许可问答](https://ffmpegwasm.netlify.app/docs/faq/)
- [Gyan Windows 构建说明](https://www.gyan.dev/ffmpeg/builds/)
- [Remotion 第三方组件与 FFmpeg 说明](https://www.remotion.dev/docs/acknowledgements)
