import * as fs from "node:fs";
import * as path from "node:path";

export interface ContextThinnessSignals {
	sourceFileCount: number;
	hasReadmeOrDocs: boolean;
	commitCount: number;
	taskChars: number;
	taskHasCodeAnchor: boolean;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".omx"]);
const SOURCE_EXTS = new Set([
	".c",
	".cc",
	".cpp",
	".cs",
	".cts",
	".go",
	".h",
	".hpp",
	".java",
	".js",
	".json",
	".jsonc",
	".jsx",
	".kt",
	".kts",
	".mjs",
	".mts",
	".php",
	".py",
	".rb",
	".rs",
	".sh",
	".swift",
	".toml",
	".ts",
	".tsx",
	".yaml",
	".yml",
]);

function countSourceFiles(cwd: string): number {
	let count = 0;
	const walk = (dir: string): void => {
		if (count >= 25) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (count >= 25) return;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
				walk(path.join(dir, entry.name));
				continue;
			}
			if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) count++;
		}
	};
	walk(cwd);
	return count;
}

function hasReadmeOrDocs(cwd: string): boolean {
	try {
		if (fs.readdirSync(cwd).some(name => /^README(?:\..*)?$/i.test(name))) return true;
	} catch {
		return false;
	}
	try {
		return fs.readdirSync(path.join(cwd, "docs"), { withFileTypes: true }).some(entry => entry.isFile());
	} catch {
		return false;
	}
}

function commitCount(cwd: string): number {
	const proc = Bun.spawnSync(["git", "rev-list", "--count", "--max-count=20", "HEAD"], {
		cwd,
		stdout: "pipe",
		stderr: "ignore",
	});
	if (proc.exitCode !== 0) return 0;
	const count = Number(proc.stdout.toString().trim());
	return Number.isFinite(count) ? count : 0;
}

export function assessContextThinness(cwd: string, task: string): { thin: boolean; signals: ContextThinnessSignals } {
	const trimmedTask = task.trim();
	const signals: ContextThinnessSignals = {
		sourceFileCount: countSourceFiles(cwd),
		hasReadmeOrDocs: hasReadmeOrDocs(cwd),
		commitCount: commitCount(cwd),
		taskChars: trimmedTask.length,
		taskHasCodeAnchor: /\/|\.\w{1,4}\b|`|\w+\(/.test(trimmedTask),
	};
	const taskIsVague = signals.taskChars < 200 && !signals.taskHasCodeAnchor;
	const repoThin =
		(signals.sourceFileCount < 10 && !signals.hasReadmeOrDocs) ||
		(signals.commitCount < 5 && signals.sourceFileCount < 10);
	return { thin: repoThin && taskIsVague, signals };
}
