/**
 * Isolated tests for dsh-soul-link.
 *
 * Three layers, matching the verification loop in AGENTS.md:
 *  A. pure functions of lib/soul.js (no host, no process spawn)
 *  B. plugin assembly against a fake ctx (tools.register / systemPrompt.section)
 *  C. **real engine**: spawn the actual `python -m soul` against the real library at
 *     D:/用户/念 — asserts UTF-8 output (the GBK-mojibake trap), the degraded paths, and a
 *     full skill write→list→delete round trip (which is the only way to prove `--file` works,
 *     since spawn's stdin is `ignore`).
 */
import assert from "node:assert/strict";

import {
	SOUL_DEFAULTS,
	buildResidentLayer,
	buildSoulArgv,
	createResidentRenderer,
	describeSoulFailure,
	listDir,
	parseSoulJson,
	readText,
	resolveSoulConfig,
	runSoul,
	sliceChars,
	stripInjectNoise
} from "./plugin/lib/soul.js";
import { apply, createSearchTool, createSkillWriteTool, createWriteTool, name as pluginName } from "./plugin/lib/index.js";

let pass = 0;
const failures = [];
function check(label, fn) {
	try {
		fn();
		pass++;
	} catch (error) {
		failures.push(`${label}: ${error.message}`);
	}
}
async function checkAsync(label, fn) {
	try {
		await fn();
		pass++;
	} catch (error) {
		failures.push(`${label}: ${error.message}`);
	}
}

/** Build a fake host context that records registrations. */
function fakeCtx() {
	const tools = [];
	const sections = [];
	const logs = [];
	return {
		tools: { register: (tool) => tools.push(tool) },
		systemPrompt: { section: (section) => sections.push(section) },
		logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
		tools_,
		sections_,
		logs_
	};
	function tools_() {
		return tools;
	}
	function sections_() {
		return sections;
	}
	function logs_() {
		return logs;
	}
}

// ---------- A. pure functions ----------
check("resolveSoulConfig 默认值（对齐原版常量名）", () => {
	const cfg = resolveSoulConfig();
	assert.equal(cfg.root, "D:/用户/念");
	assert.equal(cfg.codeDir, "D:/用户/代码/soul");
	assert.match(cfg.python, /python\.exe$/);
	assert.equal(cfg.sectionOrder, 60);
	assert.equal(cfg.sectionName, "soul-pinned");
	assert.equal(cfg.defaultLimit, 5);
	assert.equal(cfg.timeoutMs, 15000);
	assert.equal(cfg.maxPinnedChars, 12000);
	assert.equal(cfg.pinFile, "记忆/钉住.md");
	assert.equal(cfg.injectSection, true);
});
check("resolveSoulConfig 覆盖 + 空串/非有限数回落", () => {
	const cfg = resolveSoulConfig({ root: "D:/tmp/x", sectionName: "", timeoutMs: Number.NaN, maxPinnedChars: -1, defaultLimit: 0, python: "  " });
	assert.equal(cfg.root, "D:/tmp/x");
	assert.equal(cfg.sectionName, "soul-pinned", "空串应回落");
	assert.equal(cfg.timeoutMs, 15000, "NaN 应回落");
	assert.equal(cfg.maxPinnedChars, 12000);
	assert.equal(cfg.defaultLimit, 5);
	assert.match(cfg.python, /python\.exe$/, "空白 python 应回落");
});
check("buildSoulArgv 形状", () => {
	assert.deepEqual(buildSoulArgv({}, ["search", "x", "--json"]), ["-m", "soul", "search", "x", "--json"]);
});
check("sliceChars 不裂代理对", () => {
	assert.equal(sliceChars("abcdef", 4), "abcd…");
	assert.equal(sliceChars("好", 5), "好");
	assert.equal(sliceChars("😀😀😀", 2), "😀😀…");
	assert.equal(Array.from(sliceChars("😀😀😀", 2)).length, 3, "2 码点 + 省略号");
});
check("stripInjectNoise 去 HTML 注释 / 标题 / 引用 / 空行", () => {
	const text = "<!-- 人固定层（L1） -->\n\n<!-- id:a1\n · hash:x -->\n# 标题\n> 引用\n- 正文甲\n\n- 正文乙\n";
	const out = stripInjectNoise(text);
	assert.ok(!out.includes("<!--"));
	assert.ok(!out.includes("hash:x"));
	assert.ok(!out.includes("# 标题"));
	assert.ok(!out.includes("> 引用"));
	assert.ok(out.includes("- 正文甲"));
	assert.ok(out.includes("- 正文乙"));
});
check("readText / listDir 缺路径不抛", () => {
	assert.equal(readText("X:/definitely/missing.md"), "");
	assert.deepEqual(listDir("X:/definitely/missing-dir"), []);
});
check("parseSoulJson 容错", () => {
	assert.deepEqual(parseSoulJson('{"hits":[]}'), { hits: [] });
	assert.equal(parseSoulJson("not json"), null);
	assert.equal(parseSoulJson(""), null);
});
check("describeSoulFailure 退出码 → 人话（含 code 1 = 环境不可达）", () => {
	assert.match(describeSoulFailure({ code: 1, stdout: "", stderr: "没装 onnx", spawnError: null }), /环境不可达/);
	assert.match(describeSoulFailure({ code: 2, stdout: "", stderr: "锁忙", spawnError: null }), /LockBusy/);
	assert.match(describeSoulFailure({ code: 3, stdout: "", stderr: "目标 'pinned' 不可写", spawnError: null }), /被拒/);
	assert.match(describeSoulFailure({ code: 4, stdout: "", stderr: "出处守卫", spawnError: null }), /出处守卫拒绝/);
	assert.match(describeSoulFailure({ code: null, stderr: "", stdout: "", spawnError: { code: "ENOENT", path: "X:/py.exe" } }), /找不到 python/);
	assert.match(describeSoulFailure({ code: null, stderr: "", stdout: "", timedOut: true, spawnError: null }), /超时/);
});

// ---------- B. assembly ----------
check("apply 注册 5 个工具 + soul-pinned 段（order 60）", () => {
	const ctx = fakeCtx();
	apply(ctx, {});
	assert.equal(pluginName, "soul-link");
	assert.deepEqual(
		ctx.tools_().map((tool) => tool.name),
		["soul_search", "soul_write", "soul_skill_write", "soul_skill_delete", "soul_skill_list"]
	);
	assert.equal(ctx.sections_().length, 1);
	assert.equal(ctx.sections_()[0].name, "soul-pinned");
	assert.equal(ctx.sections_()[0].order, 60);
	for (const tool of ctx.tools_()) assert.equal(typeof tool.execute, "function", `${tool.name} 需要 execute`);
});
check("常驻段文本：含库根/钉住正文/目录计数，不含 HTML 注释", () => {
	const ctx = fakeCtx();
	apply(ctx, {});
	const text = ctx.sections_()[0].text();
	assert.ok(text.includes("## 灵魂库（念）"), "缺标题");
	assert.ok(text.includes("- 下面是人钉死的"), "缺钉住指引");
	assert.ok(text.includes("目录："), "缺目录计数");
	assert.ok(text.includes("soul_search"), "缺使用指引");
	assert.ok(!text.includes("<!--"), "元数据注释不该进上下文");
	assert.ok(!text.includes("hash:"), "hash 不该进上下文");
});
check("常驻段体量在 L0 预算量级（不顶爆 prompt）", () => {
	const layer = buildResidentLayer(resolveSoulConfig());
	assert.ok(layer.length > 200, `太小：${layer.length}`);
	assert.ok(layer.length <= 14000, `超过 maxPinnedChars 预算：${layer.length}`);
});
check("createResidentRenderer 按 mtime 缓存（同文件返回同一引用）", () => {
	const render = createResidentRenderer(resolveSoulConfig());
	const first = render();
	const second = render();
	assert.equal(first, second, "未变更时应命中缓存");
});
check("soul_write 的 target 只列 facts/lessons（episodes 被 argparse 拒）", () => {
	const tool = createWriteTool(resolveSoulConfig());
	assert.deepEqual(tool.parameters.target.enum, ["facts", "lessons"]);
	assert.equal(tool.parameters.content.required, true);
});
check("soul_search 空 query 直接提示（不 spawn）", async () => {
	const tool = createSearchTool(resolveSoulConfig({ python: "X:/definitely-missing.exe" }));
	const out = await tool.execute({ query: "  " }, {});
	assert.match(out, /query 不能为空/);
});
check("soul_skill_write 空 rel/content 直接提示", async () => {
	const tool = createSkillWriteTool(resolveSoulConfig({ python: "X:/definitely-missing.exe" }));
	assert.match(await tool.execute({ rel: "", content: "x" }, {}), /rel 不能为空/);
	assert.match(await tool.execute({ rel: "技能/x/SKILL.md", content: "  " }, {}), /content 不能为空/);
});

// ---------- C. real engine ----------
const realCfg = resolveSoulConfig();
await checkAsync("runSoul 真跑 soul search --json（引擎可达）", async () => {
	const result = await runSoul(realCfg, ["search", "事故", "--limit", "2", "--json", "--root", realCfg.root], {});
	assert.equal(result.ok, true, `应成功，实际 code=${result.code} out=${result.out.slice(0, 300)}`);
	const data = parseSoulJson(result.out);
	assert.ok(data, "输出必须是合法 JSON");
	const hits = Array.isArray(data) ? data : data.hits;
	assert.ok(Array.isArray(hits) && hits.length > 0, "应至少命中 1 条");
	assert.equal(typeof hits[0].content, "string");
});
await checkAsync("UTF-8：真跑输出无 U+FFFD 乱码（GBK 陷阱）", async () => {
	const result = await runSoul(realCfg, ["search", "记忆", "--limit", "1", "--json", "--root", realCfg.root], {});
	assert.equal(result.ok, true);
	assert.ok(!result.out.includes("\uFFFD"), "出现替换字符 = PYTHONIOENCODING 没生效");
	assert.ok(/[\u4e00-\u9fa5]/.test(result.out), "应含中文正文");
});
await checkAsync("runSoul 真跑 skills-list --json（空库也是合法数组）", async () => {
	const result = await runSoul(realCfg, ["skills-list", "--json", "--root", realCfg.root], {});
	assert.equal(result.ok, true, `stderr=${result.out.slice(0, 200)}`);
	assert.ok(Array.isArray(parseSoulJson(result.out)), `应为数组：${result.out.slice(0, 120)}`);
});
await checkAsync("AI 写 pinned 被引擎拒（exit 3）—— 分权硬约束真机验证", async () => {
	const result = await runSoul(realCfg, ["write", "不该写进去", "--target", "pinned", "--root", realCfg.root], {});
	assert.equal(result.ok, false, "写 pinned 必须失败");
	assert.equal(result.code, 3, `退出码应为 3，实际 ${result.code}`);
	assert.match(result.out, /pinned|不可写/);
});
await checkAsync("引擎不可达优雅退化（ENOENT）", async () => {
	const result = await runSoul(resolveSoulConfig({ python: "X:/definitely-missing-python.exe" }), ["stats", "--root", realCfg.root], {});
	assert.equal(result.ok, false);
	assert.ok(result.spawnError, "应报 spawn 错误而不是抛异常");
	assert.match(describeSoulFailure(result), /找不到 python/);
});
await checkAsync("超时优雅退化（1ms）", async () => {
	const result = await runSoul(realCfg, ["stats", "--root", realCfg.root], { timeoutMs: 1 });
	assert.equal(result.ok, false);
	assert.equal(result.timedOut, true);
	assert.match(describeSoulFailure(result), /超时/);
});
await checkAsync("★ 技能闭环：skill-write --file 写入 → skills-list 看到 → skill-delete 删掉", async () => {
	const rel = "技能/smoke-soul-link-test/SKILL.md";
	// 出处守卫（cli.py:401 起）要求 metadata.managed: true 且 source ∈ model/evolve/legacy，
	// 否则按「人写的技能」处理并拒绝覆盖 —— 这正是分权设计（AI 不能动人写的技能）。
	const content =
		"---\nname: smoke-soul-link-test\ndescription: soul-link 隔离测试用，可删\nmetadata:\n  managed: true\n  source: model\n---\n\n# 冒烟\n\n这是 dsh-soul-link 测试写入的技能。\n";
	const write = await runSoul(realCfg, ["skill-write", rel, "--file", "X:/definitely-missing.md", "--root", realCfg.root], {});
	assert.equal(write.ok, false, "缺失 --file 必须失败（证明 --file 是必经之路，stdin 不可用）");

	const dir = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const tmp = dir.mkdtempSync(path.join(os.tmpdir(), "soul-link-test-"));
	const file = path.join(tmp, "SKILL.md");
	dir.writeFileSync(file, content, "utf8");
	try {
		const created = await runSoul(realCfg, ["skill-write", rel, "--file", file, "--root", realCfg.root], {});
		assert.equal(created.ok, true, `skill-write 应成功：${created.out.slice(0, 300)}`);

		const listed = await runSoul(realCfg, ["skills-list", "--json", "--root", realCfg.root], {});
		assert.equal(listed.ok, true);
		const skills = parseSoulJson(listed.out);
		assert.ok(Array.isArray(skills) && skills.some((s) => String(s?.name ?? "").includes("smoke-soul-link-test")), `技能应出现在列表：${listed.out.slice(0, 300)}`);

		const deleted = await runSoul(realCfg, ["skill-delete", "smoke-soul-link-test", "--root", realCfg.root], {});
		assert.equal(deleted.ok, true, `skill-delete 应成功：${deleted.out.slice(0, 300)}`);

		const after = await runSoul(realCfg, ["skills-list", "--json", "--root", realCfg.root], {});
		const remaining = parseSoulJson(after.out);
		assert.ok(Array.isArray(remaining) && !remaining.some((s) => String(s?.name ?? "").includes("smoke-soul-link-test")), "技能应已被删除");
	} finally {
		try {
			dir.rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
});

// ---------- 报告 ----------
console.log(`\n通过 ${pass} / ${pass + failures.length}`);
if (failures.length > 0) {
	for (const failure of failures) console.log("  ✗ " + failure);
	process.exit(1);
}
console.log("全部通过 ✓");
