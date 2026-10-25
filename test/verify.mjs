/**
 * 跑 dsh-soul-link 的隔离测试。
 *
 * 先把真身的 `lib/*.js` 同步进 `./plugin/lib`（测试跑的永远是插件里刚改的那份，
 * 不是副本快照），再用当前 node 跑 `run-verify.mjs` —— 它带着自己的
 * `node_modules/@deepseek-ai/dsh-tools`（shim），所以**不依赖宿主、也不用装任何东西**。
 *
 *   node test/verify.mjs
 *
 * 覆盖三层：A 纯函数（配置回落 / 去噪 / 解析 / 退出码文案）、B 装配（fake ctx 注册 5 工具 +
 * soul-pinned 段）、C **真引擎**（真 spawn `python -m soul`：UTF-8 不乱码、pinned 被拒 exit 3、
 * ENOENT/超时优雅退化、以及技能 write→list→delete 全闭环）。
 */
import { cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..", "lib");
const TARGET = join(HERE, "plugin", "lib");

let synced = 0;
for (const file of readdirSync(SOURCE)) {
	if (!file.endsWith(".js")) continue;
	cpSync(join(SOURCE, file), join(TARGET, file));
	synced++;
}
console.log(`[verify] 已同步 ${synced} 个源文件 → plugin/lib`);
console.log(`[verify] node ${process.version}`);

const result = spawnSync(process.execPath, [join(HERE, "run-verify.mjs")], { stdio: "inherit", cwd: HERE });
process.exit(typeof result.status === "number" ? result.status : 1);
