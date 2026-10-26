/**
 * dsh-soul-link — 念（AGI 灵魂库）的 DSH 薄适配器。
 *
 * 基线 = 2026-10-23 原版 `lib/index.js`（逐字复原自会话转录，见 lib/soul.js 头注释），
 * 保留它「只做三件事」的克制：① 注入常驻段（钉住 + 目录）② 注册工具 ③ 别的什么都不做。
 *
 * 刻意**不做**的（都有理由，别改回去）：
 *   - 不做 `soul_read`：库是纯文本文件（A1），`read` / `ops_read_files` 直接就能读，
 *     再注册一个 schema 等于每轮白付 token。
 *   - 不做自动检索注入（A5）：检索由模型主动调，不往 prompt 里塞 volatile recall
 *     （宿主对 volatile 注入不 KV 安全）。
 *   - 不注入全部记忆：只注入钉住层。其余靠 `soul_search` 按需拿 —— 这是「省 token」的核心。
 *   - 不写 `记忆/钉住.md`：那是人的（A3），工具枚举里没有它（引擎侧 `pinned` 只收 `--actor human`）。
 *   - **没有 soul_forget**：删记忆只能人走 CLI（蓝图 §6.1 硬禁令）。
 *
 * 失败一律 fail-soft：工具出错返回一句人话（+ 诊断后缀），不抛异常（抛了会把整轮变成错误）。
 *
 * 相对原版的三处扩写（原版是 3 工具版，技能三件套的源码在转录里零命中，按 CLI 行为实现）：
 *   - `soul_skill_write` / `soul_skill_delete` / `soul_skill_list`
 *   - `soul_write` 的 `target` 只列 facts / lessons：CLI 的 argparse 是
 *     `choices=["facts","lessons","pinned"]`，**episodes 会被拒**（实测）。
 *   - 注入段改用中文文件名 `记忆/钉住.md` 并过滤 HTML 元数据块（见 lib/soul.js ① ②）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { SOFT_FAIL, createResidentRenderer, describeSoulFailure, parseSoulJson, resolveSoulConfig, runSoul, sliceChars } from "./soul.js";

export const name = "soul-link";

/** 要 systemPrompt 的稳定段，也要工具注册表。 */
export const inject = ["systemPrompt", "tools"];

const MAX_SEARCH_HITS = 20;
/** Render cap so one runaway entry cannot flood the context. */
const MAX_RENDER_CHARS = 6000;

/** Failure text: the one-liner the model acts on, plus a diagnostic line for the human. */
function failureText(result) {
	return `${SOFT_FAIL}\n（诊断：${describeSoulFailure(result)}）`;
}

function textResult() {
	return {
		schema: { type: "string" },
		render: (_args, value) => [{ type: "text", text: String(value) }]
	};
}

// ---------------------------------------------------------------------------
// soul_search
// ---------------------------------------------------------------------------

/** `soul_search`：主动检索，绝不自动注入（蓝图 A5）。 */
export function createSearchTool(cfg) {
	return defineTool({
		name: "soul_search",
		description:
			"Search the long-term soul library (念) for things remembered across sessions: conventions, lessons, skills, past episodes, the user's preferences. Hybrid retrieval (lexical + vector, RRF) with recency and importance weighting — better than grep for \"what did we decide about X\". Use it when a detail might not be in this conversation's context. Chinese queries supported.",
		parameters: {
			query: { type: "string", required: true, description: "Concise keywords or a short phrase. Chinese supported." },
			limit: { type: "integer", description: `Max results (default ${cfg.defaultLimit}).` },
			scope: { type: "string", description: "Limit to one topic (lesson / convention / environment / …) or one file." }
		},
		output: textResult(),
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const query = String(args?.query ?? "").trim();
			if (query.length === 0) return "soul_search: query 不能为空";
			const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.min(MAX_SEARCH_HITS, Math.trunc(args.limit)) : cfg.defaultLimit;
			const argv = ["search", query, "--limit", String(limit), "--json", "--root", cfg.root];
			if (typeof args?.scope === "string" && args.scope.trim().length > 0) argv.push("--scope", args.scope.trim());
			const result = await runSoul(cfg, argv, { signal: exec?.signal });
			if (!result.ok) return failureText(result);

			const data = parseSoulJson(result.out);
			if (data === null) return `灵魂库检索返回了无法解析的内容：\n${sliceChars(result.out, 400)}`;
			// 2026-10-24 起 `--json` 返回对象 {hits:[…], related_episodes:[…]}；旧代码按数组判会直接报「无法解析」。
			const hits = Array.isArray(data) ? data : Array.isArray(data?.hits) ? data.hits : null;
			if (hits === null) return `灵魂库检索返回了非预期的结构：\n${sliceChars(result.out, 400)}`;
			if (hits.length === 0) {
				return '灵魂库这次没检索到相关内容（这表示"库里没记过"，不表示"这件事没发生"，也不表示"确认没有"）。';
			}
			const lines = hits.map((hit, index) => {
				const score = typeof hit?.score === "number" ? hit.score.toFixed(3) : String(hit?.score ?? "");
				const head = `${index + 1}. [${hit?.src || hit?.layer || "?"}] ${hit?.file || ""}${hit?.topic ? ` · ${hit.topic}` : ""} · score ${score}`;
				const body = sliceChars(String(hit?.text || hit?.content || "").replace(/\s+/g, " "), 600);
				return `${head}\n   ${body}`;
			});
			return `灵魂库命中 ${hits.length} 条：\n\n${lines.join("\n\n")}`;
		}
	});
}

// ---------------------------------------------------------------------------
// soul_write
// ---------------------------------------------------------------------------

/** `soul_write`：写 facts / lessons（钉住层与人写的技能归人管，工具改不动）。 */
export function createWriteTool(cfg) {
	return defineTool({
		name: "soul_write",
		description:
			"Remember something in the long-term soul library (念). Use for durable facts: the user's preferences, project conventions, hard lessons from mistakes, environment facts. target=facts (stable truths), lessons (what went wrong and why). This does NOT write pinned items or human-written skills — those are protected. Search first (soul_search) so you do not duplicate an entry.",
		parameters: {
			target: {
				type: "string",
				required: true,
				enum: ["facts", "lessons"],
				description: "facts = stable truth; lessons = a correction or a costly mistake, include the why."
			},
			content: { type: "string", required: true, description: "One self-contained sentence. Include paths / commands / numbers / the why — a lesson without why is just a log line." },
			topic: { type: "string", description: "Short topic tag, e.g. convention / environment / preference / lesson." },
			confidence: { type: "string", description: "Confidence tag, e.g. auto/0.6 (engine default)." }
		},
		output: textResult(),
		async execute(args, exec) {
			const target = String(args?.target ?? "").trim();
			if (target !== "facts" && target !== "lessons") {
				return `target 只能是 facts / lessons（收到 ${target || "空"}）。钉住层与人写的技能归人管，AI 改不了。`;
			}
			const content = String(args?.content ?? "").trim();
			if (content.length === 0) return "内容为空，没写。";
			const argv = ["write", content, "--target", target, "--topic", String(args?.topic ?? "general"), "--root", cfg.root, "--index"];
			if (typeof args?.confidence === "string" && args.confidence.trim().length > 0) argv.push("--confidence", args.confidence.trim());
			const result = await runSoul(cfg, argv, { signal: exec?.signal });
			if (!result.ok) return failureText(result);
			return `已记进 ${target}：${sliceChars(content, 200)}`;
		}
	});
}

// ---------------------------------------------------------------------------
// 技能三件套
// ---------------------------------------------------------------------------

/**
 * `soul_skill_write`：走出处守卫地写/覆盖一个受管技能。
 *
 * 正文必须走 `--file`：spawn 的 stdin 是 `ignore`，子进程 `sys.stdin.read()`
 * （cli.py:411）读到的永远是空串 —— 走 stdin 会把技能写成空文件。
 */
export function createSkillWriteTool(cfg) {
	return defineTool({
		name: "soul_skill_write",
		description:
			"在「念」的技能库里写/覆盖一个受管技能（Markdown）。引擎会走出处守卫并记 journal；人写的技能会被拒。技能 = 可重复的操作流程，不是一次性结论。",
		parameters: {
			rel: { type: "string", required: true, description: "技能相对路径，例如 技能/xxx/SKILL.md" },
			content: { type: "string", required: true, description: "技能正文（Markdown，含 front matter 更好）" }
		},
		output: textResult(),
		async execute(args, exec) {
			const rel = String(args?.rel ?? "").trim();
			const content = String(args?.content ?? "");
			if (rel.length === 0) return "soul_skill_write: rel 不能为空";
			if (content.trim().length === 0) return "soul_skill_write: content 不能为空";

			const dir = mkdtempSync(join(tmpdir(), "soul-link-"));
			const file = join(dir, "SKILL.md");
			try {
				writeFileSync(file, content, "utf8");
				const result = await runSoul(cfg, ["skill-write", rel, "--file", file, "--root", cfg.root], { signal: exec?.signal });
				if (!result.ok) return failureText(result);
				return result.out.length > 0 ? result.out : `已写入技能 ${rel}`;
			} finally {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					/* 临时目录清不掉不该影响结果 */
				}
			}
		}
	});
}

/** `soul_skill_delete`：只删 AI 自己写的技能（人写的会被引擎拒，退出码 4）。 */
export function createSkillDeleteTool(cfg) {
	return defineTool({
		name: "soul_skill_delete",
		description: "从「念」的技能库删掉一个**AI 自己写的**技能。人写的技能会被引擎拒绝（退出码 4）。",
		parameters: {
			name: { type: "string", required: true, description: "技能目录名，例如 a-candidate-skill" }
		},
		output: textResult(),
		async execute(args, exec) {
			const skillName = String(args?.name ?? "").trim();
			if (skillName.length === 0) return "soul_skill_delete: name 不能为空";
			// 注意：`skill-delete` **没有注册 `--json`**（cli.py 只给了 name + --actor），读文本。
			const result = await runSoul(cfg, ["skill-delete", skillName, "--root", cfg.root], { signal: exec?.signal });
			if (!result.ok) return failureText(result);
			return result.out.length > 0 ? result.out : `已删除技能 ${skillName}`;
		}
	});
}

/** `soul_skill_list`：列技能（名字 + 一行描述 + 谁写的）。 */
export function createSkillListTool(cfg) {
	return defineTool({
		name: "soul_skill_list",
		description: "列「念」技能库里的技能：名字 + 一行描述 + 是 AI 写的还是人写的（demoted 的已滤掉）。",
		parameters: {},
		output: textResult(),
		isConcurrencySafe: () => true,
		async execute(_args, exec) {
			const result = await runSoul(cfg, ["skills-list", "--json", "--root", cfg.root], { signal: exec?.signal });
			if (!result.ok) return failureText(result);
			const data = parseSoulJson(result.out);
			const list = Array.isArray(data) ? data : Array.isArray(data?.skills) ? data.skills : null;
			if (list === null) {
				return result.out.length > 0 ? result.out : "「念」技能库：空";
			}
			if (list.length === 0) return "「念」技能库：还没有技能";
			const lines = [`「念」技能库：${list.length} 个`];
			for (const skill of list) {
				const skillName = skill?.name ?? skill?.rel ?? "(无名)";
				const who = skill?.kind ?? skill?.source ?? skill?.origin ?? "";
				const summary = skill?.description ?? skill?.summary ?? "";
				const stats = Number.isFinite(skill?.uses) || Number.isFinite(skill?.wins) ? ` · uses ${skill?.uses ?? 0}/${skill?.wins ?? 0}` : "";
				lines.push(`- ${skillName}${who ? ` · ${who}` : ""}${summary ? ` · ${summary}` : ""}${stats}`);
			}
			return lines.join("\n");
		}
	});
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 插件入口。
 * @param ctx - context with `systemPrompt` and `tools` (guaranteed by `inject`).
 * @param rawConfig - see {@link resolveSoulConfig} for the overridable keys.
 */
export function apply(ctx, rawConfig) {
	const cfg = resolveSoulConfig(rawConfig);

	// ① 稳定段：钉住层 + 目录。文件没变 ⇒ 字符串逐字节相同 ⇒ 前缀缓存可命中。
	try {
		const render = createResidentRenderer(cfg);
		const text = render();
		if (cfg.injectSection && text) {
			ctx.systemPrompt.section({
				name: cfg.sectionName,
				order: cfg.sectionOrder,
				text: () => render()
			});
			ctx.logger?.info?.(`soul-link：已注入灵魂库段（钉住 + 目录，库根 ${cfg.root}）`);
		} else {
			ctx.logger?.warn?.(`soul-link：未注入灵魂库段（injectSection=${cfg.injectSection}，库根 ${cfg.root}）`);
		}
	} catch (error) {
		// 注入失败不该让整轮起不来：工具还能用，模型还能主动查。
		ctx.logger?.warn?.(`soul-link：注入段失败（已降级为只有工具）：${String(error)}`);
	}

	// ② 五个工具。刻意没有 soul_read（库是纯文本，read 工具就够），也没有 soul_forget（硬禁令）。
	const tools = [createSearchTool(cfg), createWriteTool(cfg), createSkillWriteTool(cfg), createSkillDeleteTool(cfg), createSkillListTool(cfg)];
	for (const tool of tools) ctx.tools.register(tool);
	ctx.logger?.info?.(`soul-link：已注册 ${tools.map((tool) => tool.name).join(" / ")}`);

	// ③ 技能用量记账（2026-10-26）：`skill` 工具由宿主提供（在 preset 的 plugins 树里，
	// patch 层改不到它的 id），但它每次加载都会在会话里留下一条 `assistant/message`
	// 里的 tool-call 块 —— 从那里捞名字就够了：不改 preset、不包装 ctx.skills、
	// 也不需要 `skills` 服务（host 层本来就没有那个实例）。
	//
	// 三条纪律：
	//   1. **fire-and-forget** —— 记账慢一点、失败都不该拖住任何一轮（同工具的 fail-soft）。
	//   2. **callId 去重** —— `session/event` 会重放历史（续会话 / fork），不去重的话
	//      同一次加载会被记很多遍，wins/uses 比例直接失真。
	//   3. **名字交给引擎筛** —— 念侧 `skills_record.note_use` 只认
	//      `技能/<name>/SKILL.md` 存在的技能，宿主自带的 office / screenshot 不会进战绩表。
	const seenCalls = new Set();
	try {
		ctx.on?.("session/event", (session, event) => {
			if (event?.type !== "assistant/message") return;
			const blocks = event?.data?.message?.content;
			if (!Array.isArray(blocks)) return;
			for (const block of blocks) {
				if (block?.type !== "tool-call" || block?.name !== "skill") continue;
				const key = `${typeof session?.id === "string" ? session.id : ""}:${String(block.id ?? "")}`;
				if (seenCalls.has(key)) continue;
				// 宿主是常驻进程，Set 得自己封顶：清了顶多把重放的历史再记一遍，
				// 不清就是一条只会涨的内存泄漏。
				if (seenCalls.size > 4096) seenCalls.clear();
				seenCalls.add(key);
				const skillName = block?.arguments?.name;
				if (typeof skillName !== "string" || !skillName) continue;
				// 不 await：这一轮该跑还得跑。runSoul 本身 never reject，catch 只是兜底。
				runSoul(cfg, ["skill-use", skillName, "--root", cfg.root]).catch(() => {});
			}
		});
	} catch (error) {
		ctx.logger?.warn?.(`soul-link：技能记账订阅失败（已跳过，不影响工具）：${String(error)}`);
	}
}
