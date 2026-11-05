# Beta持续发布：一次配置

此清单在评估确认代码已合入main后执行。无需创建beta-publish环境，也无需为自动Beta逐次批准。

1. 在Cloudflare R2为现有zaovra-updates桶创建仅此桶的Object Read & Write凭据。不要授予账户管理权限；不要把凭据发到聊天或研发记录。
2. 在GitHub仓库Settings → Secrets and variables → Actions → Repository secrets中添加R2_UPDATES_ACCESS_KEY_ID与R2_UPDATES_SECRET_ACCESS_KEY；直接粘贴上一步的Access Key ID和Secret Access Key。
3. 等下一次main的test/typecheck完成。windows-beta精确核验该SHA；test全绿或仅具名K63、typecheck绿才构建并自动发布。缺少凭据会在版本预留阶段失败，不更改旧beta.yml。

缺省生成未签名Beta，包内和发布说明均标识。证书部署完成后，由评估开启WINDOWS_SIGNING_ENABLED=true；签名失败会阻断，禁止退回unsigned。prod的签名与手动批准规则不变。原手动build_only保留。

版本固定0.1.1-beta.N：扫描全部已存在版本路径/预留和当前指针，使用R2原子If-None-Match预留下一号。失败的预留不回收，N允许有空号；超过65535或已存在更新base时停下交评估定版。

安装器和blockmap先上传到不可变版本路径，经存储与公网哈希回读；说明/manifest随后写入；beta.yml最后条件更新。指针公网回读失败时，只在仍拥有该指针时条件恢复旧版，无法确认时明确报错。公开指针核验成功后才按原策略保留最近五版；清理失败单独标为deferred，不影响已验证的新指针。版本预留永久保留，清理后的旧号也不复用。

此清单不包含或执行真实凭据读取、云配置或上传。本地证据只验证合成HTTP对象服务与makensis编译；首次托管自动发布及实际更新仍待精确CI验收。
