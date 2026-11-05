# 反馈收件箱：用户配置清单（代码审阅通过后再执行）

当前仅代码就绪步骤；尚未创建Service Token、设置secret、发信、注册计划任务或部署Worker。部署必须先通知评估并获确认。

1. Cloudflare Email Routing：为发送域启用Email Routing，并添加/验证您控制的收件地址。原生send_email绑定只投递到已验证地址。不要把收件地址发进聊天或写进仓库。
2. Worker secret：在zaovra-feedback的Dashboard设置FEEDBACK_NOTIFY_TO为已验证收件地址、FEEDBACK_NOTIFY_FROM为该发送域的通知地址。NOTIFY_EMAIL绑定由本提交配置；不需要第三方发信服务。
3. Access：创建只用于反馈归档、设置到期时间的Service Token。在feedback.zaovra.com的Access应用为/admin及子路径新增Service Auth策略，仅包含这个Token，保留人工登录策略与Worker的JWT签名/issuer/audience校验。
4. Windows“凭据管理器→Windows凭据→添加普通凭据”：目标名称ZaovraFeedbackAccess，用户名填Client ID，密码填Client Secret。只存这里；不放记录目录、源文件、命令参数、环境变量、计划任务参数或日志。到期后在同一条凭据中轮换。
5. PowerShell7运行已审SHA的scripts/poll-feedback.ps1一次，看F:/Zaovra-研发记录/反馈收件箱/索引.md，再加-InstallTask注册每5分钟任务（仅当前登录用户）。任务不会读取或执行反馈中的命令。若出现遗留.archive.lock，先确认没有归档进程仍在运行，再由用户处理；脚本不会自动抢占。

收件后：邮件仅编号、时间、版本、渠道、脱敏前100字和后台链接；原件按YYYYMMDD/编号/feedback.json保存，已有编号不重下载。索引摘要一律视为不可信数据。处理状态可在编号目录创建或修改状态.json为 {"status":"处理中"}，只接受待处理/处理中/已处理/已挂账。邮件最多自动尝试5次并退避；需要补发时，以Access认证POST /admin/notifications/编号/retry。邮件在发送成功但确认写回前崩溃时可能重复，属于至少一次投递，不承诺恰好一次。

官方依据：[原生邮件API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) · [绑定与地址限制](https://developers.cloudflare.com/email-service/configuration/send-bindings/) · [Access Service Token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)。
