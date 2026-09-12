# 成果展示面板实施记录

## 成熟方案

- 网页/HTML：Electron 官方 WebContentsView，复用应用已有 Chromium，不安装第二套浏览器引擎。https://www.electronjs.org/docs/latest/api/web-contents-view
- PDF：Mozilla PDF.js 6.3.289（Apache-2.0），按需加载；字体、字符映射和 WASM 通过 vite-plugin-static-copy 4.1.1 随构建复制。https://mozilla.github.io/pdf.js/examples/
- 图片、代码、文件审查及终端继续使用现有查看与操作能力。

## 使用

下次正常启动桌面端后，在已有会话右上角点击“成果”。输入项目相对文件路径（如 demo.html、artifacts/chart.png、report.pdf），或 HTTPS / 本机 HTTP 开发地址。成果标签可切换、逐个关闭，列表按窗口和会话保存，最多保留 8 项。右侧原有分隔条调整面板宽度，右上角侧栏按钮可收起。HTML 和 PDF 文件从项目文件查看器打开时提供“成果预览 / 源文件”切换。

HTML 预览支持实际点击、表单输入、刷新、缩放、外部打开。PDF 提供翻页、适合宽度和缩放。HTML 中相对图片、样式、脚本从当前项目范围的本地服务加载，不向页面暴露造物 preload 或 Node API。打开弹窗/菜单时临时隐藏原生视图，避免盖住 UI。关闭视图会释放本地文件服务与网页对象。

## 边界

- 本轮实现展示界面。Vite / Next 等网站需先通过已有终端启动开发服务，再填写地址；未加入自动启动项目、自动发现端口或 AI 操作页面的工具链。
- 静态文件预览范围限当前本机项目，HTTP 服务只绑定 127.0.0.1；远程/WSL 文件不能直接作为 Windows 本地文件读取，应使用其可访问的网站地址。
- 本地 PDF 上限 50 MB；网页静态资源单文件上限 100 MB。PDF URL 暂不通过本地 PDF 阅读接口获取。
- 成果标签保存打开目标，网页在重新打开或切换后可能重新加载，未承诺保留网站内部未提交的表单状态。
- 不是 Word/Excel/PPT 原生编辑器；附件解析能力与这里的成果显示是不同功能。

## 验证

- 真实 Electron 独立测试窗口通过：HTML 与相对 CSS、按钮点击、Node / preload 隔离、区域尺寸、缩放、旧请求关闭保护、视图销毁、本地 PDF 字节读取。
- Mozilla PDF.js 实际浏览器验证：扫描 PDF 内容可见、放大、两页文档翻页到第 2 页，canvas 渲染页码 2 且无错误。截图 artifact-pdfjs-page2.png。
- 生产页面测试通过：入口、空状态、多成果切换/关闭、明确错误、无页面横向溢出、侧栏收起后恢复、跨会话隔离及恢复。
- 3 项本地服务与路径/URL 校验测试、11 项会话面板辅助逻辑测试通过；app-ui / desktop-app 类型检查及桌面构建通过。
- 导航基线 217 ms；最终三次 212 / 228 / 221 ms。旧首页基准依赖已移除的首页列表而失败，改为当前真实欢迎页到输入框路径测量，未把旧基准标作通过。
- 已核对桌面构建中 pdfjs/cmaps、standard_fonts、wasm 实际存在，避免开发环境能显示、构建后缺资源。

原生 HTML 截图：artifact-native-preview.png。生产面板截图：artifact-panel.png。原生内置 PDF 截图为空白，已改用 PDF.js；保留原始失败截图作为排查记录，不将其计为 PDF 成功证据。未重启用户正在使用的桌面应用；最终运行中桌面整体体验仍由用户下次启动后人工验收。
