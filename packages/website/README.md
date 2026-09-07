# 造物官网

Windows 本地测试：双击本目录唯一的 `启动器.bat`，浏览器会打开 `http://127.0.0.1:3001`。

官网入口在 `app/`，首页源码是 `app/src/routes/index.tsx`。账户、订阅等页面也在 `app/src/routes/`。

- `core/`：网站业务逻辑。
- `function/`：网站服务函数。
- `resource/`：网站资源绑定。
- `mail/`：邮件模板。
- `support/`：支持工具。

在仓库根目录运行 `bun run dev:website`。文档站在 `../website-docs/`，桌面端在 `../desktop-app/`，工作台界面在 `../app-ui/`。

详细命令与迁移说明见根目录 `目录说明.md`。
