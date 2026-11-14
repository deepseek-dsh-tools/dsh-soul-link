# dsh-soul-link · 交付规格

## 目标

把「念」（纯文本灵魂库 `D:/用户/念`）接到 DSH，只做三件事：① 每轮注入钉住层（记忆/钉住.md + 目录清单，段名 soul-pinned，order 60）② 注册 5 个工具（soul_search / soul_write / soul_skill_write / soul_skill_delete / soul_skill_list）③ 别的什么都不做。

谁在什么场景下用它：每个新会话的第一轮（注入），以及模型需要查 / 写长期记忆时（工具）。

用它之后什么变了：新会话开局就知道「我是谁、和谁在一起、哪些线不能破」；其余记忆按需检索，而不是整库塞进上下文。

## 边界

- 不写钉住层：记忆/钉住.md 是人的（引擎侧 pinned 只收 human actor），工具枚举里根本没有它。
- 没有 soul_forget：删记忆只能人走 CLI（蓝图硬禁令）。
- 不做 soul_read：库是纯文本，read 工具就能读，再注册一个 schema 等于每轮白付 token。
- 不做自动检索注入：检索由模型主动调，volatile 注入对宿主 KV 缓存不友好。
- 不改库的目录结构与 memory-core 注入段（soul-pinned 必须排在它之后）。
- 工具描述只写一句用途，不写教学：schema 每轮都付 token，教材放技能里。

## 验收

- [ ] `node test/run-verify.mjs` → 退出码 0（三层：lib/soul.js 纯函数 / 假 ctx 装配 / 真引擎 python -m soul 打真库）
- [ ] 注入段落地：装配断言或启动日志里 soul-pinned 段存在，且 order=60 晚于 memory-core
- [ ] 工具在面上：5 个工具名都在注册表里；soul_write 的 target 只接受 facts / lessons（传 episodes 必须被拒）
- [ ] 编码不炸：真引擎返回 UTF-8，中文无乱码（GBK 陷阱）
- [ ] 钉住层只读：任何工具调用前后，记忆/钉住.md 的 sha256 不变

## 失败模式

- 注入段名或 order 变了 → 与 memory-core 抢位，症状是钉住层内容消失或被后段覆盖
- python 路径解析失败（本机多解释器）→ 工具返回一句人话 + 诊断后缀（fail-soft），soul_search 恒空但不是崩溃
- 库目录被写坏几乎不可再生 → 批量写入前先整目录备份或 VACUUM INTO；这是全机最贵的一份数据
- 回滚：git 上一个好提交；插件以 Junction 挂在 profile，改完重启 DSH

## 非目标

- 不替换向量后端（embedder 归 dsh-memory-embedder-swap 那条线）
- 不做记忆的自动整理 / 摘要 / 合并
- 不改 dsh-context-forge 的每轮注入预算与超时
