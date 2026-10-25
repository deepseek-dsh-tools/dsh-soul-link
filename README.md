# dsh-soul-link

把「念」（AGI 灵魂库，`D:/用户/念`）接到 DeepSeek Harness 的薄适配器。

> 2026-10-25 事故后重建：宿主更新事故（官方 0.2.1-rc.3 安装包整体替换 `D:\DSH`）连符号链接
> 目标一起删掉了插件源码。本版以 **2026-10-23 的原版**（从会话转录逐字复原）为基线，
> 按引擎现状修四处、扩写技能三件套。

## 它做什么（只做三件事）

1. **注入常驻段**：把 `记忆/钉住.md`（人钉死的）+ 目录清单注入 system prompt
   （段名 `soul-pinned`，order 60，排在 `memory-core` 之后）。
2. **注册 5 个工具**：
   | 工具 | 干什么 |
   |---|---|
   | `soul_search` | 混合检索（词法 + 向量 RRF，时效/重要度加权）事实/教训/经验 |
   | `soul_write` | 写 facts / lessons（**不能写钉住层**，AI 改不动） |
   | `soul_skill_write` | 写/覆盖受管技能（文中必须带 `metadata.managed: true`） |
   | `soul_skill_delete` | 删 AI 自己写的技能（人写的被引擎拒） |
   | `soul_skill_list` | 列技能（名字 + 一行描述 + 谁写的） |
3. 别的什么都不做。

**刻意不做**：不注册 `soul_read`（库是纯文本，`read` 工具够用）；不做自动检索注入
（蓝图 A5：检索由模型主动调，volatile 注入破坏前缀缓存）；不注入记忆正文（只注入钉住层，
其余按需 `soul_search`）；没有 `soul_forget`（删记忆只能人走 CLI）。

## 挂载

`package.json` 已有 `dsh.bundle.patch`，所以只要在 profile 里加依赖与 bundles：

```jsonc
// profiles/desktop/package.json
"dependencies": { "dsh-soul-link": "link:D:/用户/工具/dsh-plugins/dsh-soul-link" },
"dsh": { "profile": { "bundles": [ /* …, */ "dsh-soul-link" ] } }
```

配置写在 profile 的 `cordis.patch.yml`（顶层 `- id: soul-link`，整键替换）：

```yaml
- id: soul-link
  name: dsh-soul-link
  config:
    root: D:/用户/念
    codeDir: D:/用户/代码/soul
    python: D:/用户/工具/pythons/cpython-3.12.15-windows-x86_64-none/python.exe
    timeoutMs: 15000
    maxPinnedChars: 12000
    defaultLimit: 5
```

## 为什么走 CLI 而不是 MCP

引擎里 `soul/mcp_server.py` 有 stdio JSON-RPC 的 5 个 MCP 工具，但 **CLI 没有 `mcp` 子命令**，
且 MCP 那组工具名（search/write/read/reflect/state）与这里的 5 个对不上。
蓝图 §11.0.1 明确留了退路：「如果哪天 DSH 不支持 MCP，退一步用『系统提示注入 + CLI 调用』也能活」。

## 四个必须知道的坑

1. **钉住文件是 `记忆/钉住.md`**，不是 `pinned.md`（commit 26ba153 改的名）。
   写死 `pinned.md` 会静默读空 —— 注入段看着正常，其实一条钉住都没进去。
2. **`PYTHONIOENCODING=utf-8` 不能省**。Windows 控制台默认 GBK，`--json` 里的中文会变成
   `"root": "D:\\�û�\\��"`（实测）。
3. **`skill-write` 的正文必须走 `--file`**。`spawn` 的 stdin 是 `ignore`，
   子进程 `sys.stdin.read()`（`cli.py:411`）永远读到空串 —— 走 stdin 会把技能写成空文件。
   技能正文还得带 `metadata.managed: true` + `source: model`，否则出处守卫按「人写的」拒绝（退出码 4）。
4. **技能目录名不能以 `_` 开头**。`store.py` 的 `list_skills()` 跳过 `_` 前缀目录
   （视作内部目录），写了也不会出现在 catalog 里。

## 验证

```powershell
# 隔离测试（22 项，含真跑引擎 + 技能写入/删除闭环）
cd D:\用户\工具\Temp\soul-test ; node test.mjs
```

`--json` 输出结构：`search` 返回 `{hits:[…], related_episodes:[…]}`（**是对象不是数组**，
2026-10-24 起如此）；`skills-list` 返回数组（`state == "demoted"` 的已被引擎滤掉）。

退出码：`0` 成功 / `1` 环境不可达 / `2` LockBusy / `3` SoulError（含「不可写」） / `4` 出处守卫拒绝。
工具侧一律 fail-soft：失败返回「灵魂库暂时不可用…」+ 一行诊断，不抛异常（抛了会把整轮变成错误）。
