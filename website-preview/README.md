# Zaovra 官网预览

将 `Zaovra-preview.html` 单独发送给预览者，保存后使用 Chrome 或 Edge 双击打开即可，无需启动服务器。字体、图片、样式及交互脚本均已内嵌，雷达与引力动画可以离线运行。

下载、GitHub、文档等外部链接需要联网；语言菜单保留目前的选择行为，尚未接入正文翻译。

## 更新

源代码：`packages/website-redesign`。不要直接编辑生成的 HTML。

每次修改官网后，在源代码目录运行 `bun run build`，会同时更新正式构建及本文件夹内的预览。只更新单文件预览可运行 `bun run export:preview`。
