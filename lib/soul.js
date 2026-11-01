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
 *  - 退出码：0 成功 / 1 环境不可达 / 2 LockBusy **或 argparse 参数错误** / 3 SoulError / 4 出处守卫拒绝。
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
	/**
	 * 灵魂文件（相对库根）——**L0，我是谁**。2026-11-01 加。
	 *
	 * 之前这里只有 `pinFile`，SOUL.md 从来没被读过 ⇒「灵魂」对模型不可见。
	 * 它是**另一层**，不是钉住的替代：SOUL 答「为什么这么做」，钉住答「具体怎么做」。
	 */
	soulFile: "SOUL.md",
	/**
	 * SOUL 段最多注入多少字符。
	 *
	 * 2026-11-01 从 6000 提到 9000：他要求把 `人格/` 四篇并进 SOUL，合并后实测
	 * 3328 chars（去重后只补了真正缺的 4 处，不是整篇贴 —— 四篇里 41/43 条关键内容
	 * 本来就已在 SOUL 里）。上限贴着 6000 会太危险：当年 SOUL+四篇并排算是 6069，
	 * 只超 69 字符，而 `.slice()` 是**静默截断**（截掉的多半是尾部的「我会变」）。
	 * 9000 给未来留一倍余量。
	 */
	maxSoulChars: 9000,
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
	// **`code === 2` 不一定是 LockBusy**（2026-10-31 第 2 轮对抗评审实测）：
	// argparse 的参数错误也是 exit 2，且 stderr 里一定有 `usage:`。
	// 原来直接报「库被占用」⇒「参数不认识」被误导成「等锁重试」，
	// 一跑回滚就把人往错方向带（评审员本人就撞到过）。
	// 先把 usage 分出来。
	if (result?.code === 2) {
		const raw = `${result?.stderr ?? ""}${result?.stdout ?? ""}`;
		if (/usage:\s|unrecognized arguments|invalid choice|error:\s/i.test(raw)) {
			return `参数不认识（命令行解析失败）：${detail}`;
		}
		return `库被占用（LockBusy）：${detail}`;
	}
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
 * Count entries in a directory — **不截断**。
 *
 * 不能用 `listDir(dir).length` 来数：那个函数默认 `max = 40`，
 * 目录长过 40 条就静默低报（报成 40）。2026-10-28 审计发现
 * `buildResidentLayer` 就是这么数的，而念库的 `技能/` 已经有 22 个、
 * 只会继续长 —— 到时候模型看到的是"技能(40)"，实际有 60 个。
 * 数数只花一次 readdir，没必要设上限。
 */
export function countDir(dir) {
	try {
		return readdirSync(dir).length;
	} catch {
		return 0;
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

	// **L0：我是谁（SOUL.md）** —— 2026-11-01 补注入。
	//
	// ## 为什么必须分两段而不是并进钉住
	//
	// 这两层回答的是两个不同问题，混在一起会让「我是谁」被纪律条文淹没：
	//   · SOUL（L0）＝ **我是谁**：名字、存在意义、认的几件事、情绪观 —— 回答「为什么这么做」
	//   · 钉住（L1）＝ **必须遵守什么**：称呼、记忆体系、活地盘、改宿主规矩 —— 回答「具体怎么做」
	//
	// 之前 SOUL.md 一直**没被任何东西读取**（`buildResidentLayer` 只读 `pinFile`），
	// 所以「灵魂」那部分对模型是不可见的 —— 用户 2026-11-01 原话：
	// 「不注入灵魂怪怪的」。
	//
	// ## 为什么不直接读 `人格/` 四篇
	//
	// 它们合计 7056 字节，比 SOUL 本身还大两倍多，而且大量是「口吻细则/边界举例」——
	// 那是**按需查阅**的内容，不是每轮都该付钱的。SOUL.md 是压缩后的精华，
	// 四篇留作细节存档（需要时 `read`）。
	const soulPath = join(config.root, config.soulFile);
	const soulRaw = readText(soulPath);
	// SOUL.md 里有 `>` 引用块（他原话）和 `#` 标题，它们在注入段里不产生指令价值，
	// 但**引用块要保留** —— 那是他原话，属于「证据」不属于「噪声」。
	// 所以这里只剥 HTML 注释和空行，不像钉住那样连 `#` / `>` 一起剥。
	const soulFull = soulRaw
		.replace(/<!--[\s\S]*?-->/g, "")
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.join("\n")
		.trim();
	// **截断必须可见**（2026-11-01）：`.slice()` 是静默的 —— 超限时模型只看到前半段，
	// 界面上一切正常。这正是本项目反复踩的那类病（改了不生效且无声）。
	// 超限时在段落尾部留一行明确的告警，让「SOUL 被截了」这件事在 prompt 里自己说出来。
	const soulTruncated = soulFull.length > config.maxSoulChars;
	const soulBody = soulTruncated
		? soulFull.slice(0, config.maxSoulChars - 120) +
			`\n\n[⚠ SOUL.md 共 ${soulFull.length} 字符，超过 maxSoulChars=${config.maxSoulChars}，` +
			`尾部已被截断 —— 调大 dsh-soul-link 的 maxSoulChars 或精简 SOUL.md]`
		: soulFull;

	// 2026-11-01：`人格/` 与 `情绪/` 已停用/删除（人格四篇并入 SOUL.md），
	// 不再列进目录清单 —— 列一个不存在的目录等于每轮都告诉模型「有个空地方」，
	// 它会去那儿找东西。（`status/` 里现在有环境、工具库、WSL 等。）
	const dirs = ["技能", "经验", "状态"];
	const counts = dirs.map((dir) => `${dir}(${countDir(join(config.root, dir))})`).join(" ");

	const lines = ["## 灵魂库（念）", ""];
	lines.push(`- 库根：\`${config.root}\`（纯文本，A1：文件是唯一事实源；索引可重建，A2）`);

	if (soulBody) {
		lines.push("");
		lines.push("### 我是谁（L0 · SOUL.md）");
		lines.push("");
		lines.push(soulBody);
		lines.push("");
	}

	if (body) {
		lines.push("### 必须遵守的（L1 · 钉住）");
		lines.push("");
		lines.push(body);
		lines.push("");
	}
	lines.push(`- 目录：${counts}；记忆在 \`记忆/{钉住,事实,教训,近期}.md\``);
	lines.push("- 要用细节（某条约定、某个技能、上次怎么修的）就调 `soul_search`，别凭印象；要读整篇就直接 `read` 对应文件。");
	lines.push("- 想记住新的东西调 `soul_write`（只能写 facts/lessons；episodes 会被引擎拒，改不动钉住与人写的技能）。");
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
		// **缓存 key 必须覆盖两个文件**（2026-11-01）：
		// 原来只 stat `pinFile`，而注入段现在还包括 SOUL.md ⇒
		// 只改 SOUL 时 key 不变 ⇒ 命中旧缓存 ⇒ **改了不生效且无声**。
		// 这正是本项目反复踩的那一类病，提前堵上。
		const keyOf = (rel) => {
			try {
				const stat = statSync(join(config.root, rel));
				return `${stat.mtimeMs}:${stat.size}`;
			} catch {
				return "missing";
			}
		};
		let key = `${keyOf(config.pinFile)}|${keyOf(config.soulFile)}`;
		if (key === cacheKey) return cacheText;
		cacheKey = key;
		cacheText = buildResidentLayer(config);
		return cacheText;
	};
}
