/**
 * 念（soul）引擎调用层 —— dsh-soul-link 的 CLI 适配。
 *
 * 基线 = 2026-10-23 原版 `lib/index.js`（从会话转录 Temp\cur.jsonl 逐字复原到
 * Temp\recovery\_soul_recon\），本文件保留它的常量名与失败语义，只做四处有证据的修正：
 *
 *  ① `记忆/钉住.md` 取代 `记忆/pinned.md`
 *     commit 26ba153 把文件改成了中文名；写死 pinned.md 会**静默读空**（readText 返回 ""）。
 *  ② 过滤 `<!-- … -->` 元数据块
 *     引擎写回的每条记忆都带 `<!-- id:xxxx · hash · conf … -->`；注入它是纯浪费（蓝图 §4.2）。
 *  ③ `search --json` 现在返回**对象** `{hits:[…], related_episodes:[…]}`，不是数组
 *     （实测 2026-10-25；旧代码 `Array.isArray(hits)` 会直接报「无法解析」）。
 *  ④ `skill-write` 的正文必须走 `--file`
 *     spawn 用 `stdio: ['ignore', …]`，子进程 `sys.stdin.read()`（cli.py:411）读到的永远是空串。
 *
 * 引擎接口取证（2026-10-25 实检）：
 *  - 入口 = `soul.cli:main`（pyproject `[project.scripts] soul`），零第三方依赖；
 *    `soul/mcp_server.py` 有 stdio JSON-RPC 的 5 个 MCP 工具，但 **CLI 没有 `mcp` 子命令**
 *    ⇒ 适配器只能走 CLI 子进程（蓝图 §11.0.1：「退一步用系统提示注入 + CLI 调用也能活」）。
 *  - Windows 控制台默认 GBK ⇒ **必须 PYTHONIOENCODING=utf-8**，否则 `--json` 里的中文
 *    变成 `"root": "D:\\�û�\\��"`（实测）。
 *  - 退出码：0 成功 / 1 环境不可达 / 2 LockBusy / 3 SoulError / 4 出处守卫拒绝。
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Config defaults; every key is overridable from the profile's `- id: soul-link` config. */
export const SOUL_DEFAULTS = {
	/** 库根。 */
	root: "D:/用户/念",
	/** 引擎代码目录（`python -m soul` 要在这里跑）。 */
	codeDir: "D:/用户/代码/soul",
	/** 用哪个解释器。 */
	python: "D:/用户/工具/pythons/cpython-3.12.15-windows-x86_64-none/python.exe",
	/** 注入段的排序（memory-core 是 50，我们排在它后面）。 */
	sectionOrder: 60,
	/** 段名（同名会覆盖，别跟别人撞）。 */
	sectionName: "soul-pinned",
	/** 检索默认条数。 */
	defaultLimit: 5,
	/** 单次 CLI 调用的超时（毫秒）。 */
	timeoutMs: 15000,
	/** 钉住层最多注入多少字符（宁可少注入也不能顶爆 prompt）。 */
	maxPinnedChars: 12000,
	/** stdout 熔断：超过这么多字符就杀掉子进程（防一条疯掉的检索把内存吃光）。 */
	maxOutputChars: 400000,
	/** 钉住文件（相对库根）。 */
	pinFile: "记忆/钉住.md",
	/** 是否注入常驻段（关掉只剩工具）。 */
	injectSection: true
};

/** 引擎调用失败时给模型看的短句（不抛 —— 抛了会把整轮变成错误）。 */
export const SOFT_FAIL = "灵魂库暂时不可用（引擎调用失败），这次先按你已有的上下文判断，别当成「库里没有」。";

/** Merge user config over {@link SOUL_DEFAULTS}; blank strings and non-finite numbers fall back. */
export function resolveSoulConfig(config = {}) {
	const merged = { ...SOUL_DEFAULTS };
	for (const key of Object.keys(SOUL_DEFAULTS)) {
		const value = config?.[key];
		if (value === undefined || value === null) continue;
		if (typeof value === "string" && value.trim().length === 0) continue;
		if (typeof value === "number" && !Number.isFinite(value)) continue;
		merged[key] = value;
	}
	if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs <= 0) merged.timeoutMs = SOUL_DEFAULTS.timeoutMs;
	if (!Number.isFinite(merged.maxPinnedChars) || merged.maxPinnedChars <= 0) merged.maxPinnedChars = SOUL_DEFAULTS.maxPinnedChars;
	if (!Number.isFinite(merged.defaultLimit) || merged.defaultLimit <= 0) merged.defaultLimit = SOUL_DEFAULTS.defaultLimit;
	return merged;
}

/** The argv one soul subcommand runs with (the `--root` belongs to the subcommand's parser). */
export function buildSoulArgv(_config, args) {
	return ["-m", "soul", ...args];
}

/**
 * Run one soul subcommand and collect stdout. **Never rejects.**
 *
 * A memory adapter that throws into the host is worse than one that reports "engine
 * unreachable": the model can still work from its context, but a thrown error kills the turn.
 *
 * @returns `{ ok, out, code, signal, stdout, stderr, timedOut, spawnError }` where `out` is
 *   the trimmed stdout on success and the trimmed stderr (or stdout) on failure.
 */
export function runSoul(config, args, options = {}) {
	const { signal, timeoutMs = config.timeoutMs } = options;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(config.python, buildSoulArgv(config, args), {
				cwd: config.codeDir,
				env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
				// stdin 关掉：引擎没有读 stdin 的子命令；skill-write 的正文走 --file（见文件头 ④）。
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true
			});
		} catch (error) {
			resolve({ ok: false, out: `起不来：${String(error)}`, code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: error });
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let timer;

		const finish = (ok, extra = {}) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (signal !== undefined) signal.removeEventListener?.("abort", onAbort);
			const payload = {
				ok,
				out: (ok ? stdout : stderr || stdout).trim(),
				stdout,
				stderr,
				timedOut,
				spawnError: null,
				...extra
			};
			resolve(payload);
		};

		function onAbort() {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			finish(false, { code: null, signal: null });
		}

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > config.maxOutputChars) {
				try {
					child.kill();
				} catch {
					/* ignore */
				}
				finish(false, { code: null, signal: null });
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			stderr = `${stderr}${String(error)}`;
			finish(false, { code: null, signal: null, spawnError: error });
		});
		child.on("close", (code, closeSignal) => finish(code === 0, { code, signal: closeSignal }));

		if (signal !== undefined) {
			if (signal.aborted) onAbort();
			else signal.addEventListener?.("abort", onAbort, { once: true });
		}
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill();
				} catch {
					/* ignore */
				}
				finish(false, { code: null, signal: null });
			}, timeoutMs);
			timer.unref?.();
		}
	});
}

/** Turn a {@link runSoul} result into the one-line diagnosis appended to {@link SOFT_FAIL}. */
export function describeSoulFailure(result) {
	if (result?.spawnError) {
		const code = result.spawnError.code ?? "";
		return code === "ENOENT"
			? `找不到 python：${result.spawnError.path ?? "(config.python)"}`
			: `启动引擎失败：${result.spawnError.message}`;
	}
	if (result?.timedOut) return `引擎超时（${result.stderr?.trim() || "无输出"}）`;
	const detail = (result?.stderr?.trim() || result?.stdout?.trim() || "无输出").slice(0, 200);
	if (result?.code === 1) return `环境不可达：${detail}`;
	if (result?.code === 2) return `库被占用（LockBusy）：${detail}`;
	if (result?.code === 3) return `被拒：${detail}`;
	if (result?.code === 4) return `出处守卫拒绝：${detail}`;
	return `退出码 ${result?.code ?? "?"}：${detail}`;
}

/** Read a UTF-8 file, returning "" when it is missing or unreadable. */
export function readText(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Directory listing (names only) — tells the model what exists without injecting content. */
export function listDir(dir, max = 40) {
	try {
		return readdirSync(dir).slice(0, max);
	} catch {
		return [];
	}
}

/**
 * Strip everything that carries no instruction: HTML metadata comments, headings,
 * blockquotes and blank lines. What remains is what the model must obey.
 */
export function stripInjectNoise(text) {
	return text
		.replace(/<!--[\s\S]*?-->/g, "")
		.split(/\r?\n/)
		.filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith(">"))
		.join("\n")
		.trim();
}

/**
 * 生成常驻段（蓝图 §5「L0 常驻」）= 钉住层 + 目录清单 + 使用指引。
 *
 * 刻意**不**注入记忆正文：那要模型主动 `soul_search`（蓝图 A5：检索由 AI 主动调用，
 * 绝不自动注入，否则 volatile 注入破坏前缀缓存）。
 */
export function buildResidentLayer(config) {
	const pinned = readText(join(config.root, config.pinFile));
	const body = stripInjectNoise(pinned).slice(0, config.maxPinnedChars);

	const dirs = ["人格", "技能", "经验", "状态"];
	const counts = dirs.map((dir) => `${dir}(${listDir(join(config.root, dir)).length})`).join(" ");

	const lines = ["## 灵魂库（念）", ""];
	lines.push(`- 库根：\`${config.root}\`（纯文本，A1：文件是唯一事实源；索引可重建，A2）`);
	if (body) {
		lines.push("- 下面是人钉死的（钉住），**必须遵守**：");
		lines.push("");
		lines.push(body);
		lines.push("");
	}
	lines.push(`- 目录：${counts}；记忆在 \`记忆/{钉住,事实,教训,近期}.md\``);
	lines.push("- 要用细节（某条约定、某个技能、上次怎么修的）就调 `soul_search`，别凭印象；要读整篇就直接 `read` 对应文件。");
	lines.push("- 想记住新的东西调 `soul_write`（只能写 facts/lessons/episodes，改不动钉住与人写的技能）。");
	lines.push('- 检索结果为空 = 「库里没记过」，不等于「这件事没发生」；别把空结果说成"确认没有"。');
	return lines.join("\n");
}

/** Parse `--json` output, returning null when the engine printed something unparsable. */
export function parseSoulJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Slice by code points so a cut never splits a surrogate pair. */
export function sliceChars(text, limit) {
	const points = Array.from(String(text ?? ""));
	return points.length <= limit ? String(text ?? "") : `${points.slice(0, limit).join("")}…`;
}

/**
 * Cache the resident layer keyed by the pinned file's mtime+size.
 *
 * 两个理由：宿主每轮都组装 prompt，而这个函数是同步的（不缓存就是每轮读盘）；
 * 且「内容没变 ⇒ 字符串逐字节相同 ⇒ 前缀缓存能命中」。
 */
export function createResidentRenderer(config) {
	let cacheKey = "";
	let cacheText = "";
	return function render() {
		const path = join(config.root, config.pinFile);
		let key = "missing";
		try {
			const stat = statSync(path);
			key = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			key = "missing";
		}
		if (key === cacheKey) return cacheText;
		cacheKey = key;
		cacheText = buildResidentLayer(config);
		return cacheText;
	};
}
