# Zaovra 本地附件组件

开发环境：在仓库根目录运行 `powershell -ExecutionPolicy Bypass -File packages/desktop-app/scripts/setup-attachments.ps1 -Advanced`。首次需要 Python 3.10+（可用 `-Python` 指定）、FFmpeg 和 ffprobe。模型仅在安装阶段下载；上传时使用项目专用虚拟环境和已下载模型。当前开发机已完成安装。

- 第一阶段：MarkItDown 0.1.5，DOCX / XLSX / PPTX 文字与表格、PDF 文字层、ZIP 内支持的文档。
- 第二阶段：Docling 2.126.0 解析 PDF 版面与 OCR；faster-whisper 1.2.1 + Whisper small 本地语音转录；FFmpeg 抽取视频关键帧。
- 单批原始附件合计最多 20 MB；单次转换最多 20 万字符，PDF 最多 100 页，媒体最多 15 分钟、最多 8 张抽样画面。
- ZIP 最多 500 个条目、展开后 100 MB；不递归解压，不执行文件，不支持的成员会列出。嵌套扫描 PDF 请单独上传做 OCR。
- Office 提取不包含嵌入图片和图表的视觉理解；Excel 不重新计算公式。旧版 DOC / XLS / PPT、RAR / 7Z 不在此次支持范围内。
- 转录与 OCR 会有识别误差；视频抽样不能覆盖所有画面。视频关键帧需要所选模型支持图片输入。

运行 `bun test src/main/attachment-convert.test.ts`（在 desktop-app 包目录）进行真实文件集成验证。没有安装本地运行时会跳过依赖它的测试，基本输入校验仍会运行。fixtures 为本地合成测试文档和系统语音，不含用户文件。

这是开发测试环境接入，尚未制作随安装包分发的 Python / FFmpeg / 模型资源，也未完成该分发组合的许可证清单。正式分发前需单独处理。
