import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const codingAgent = path.join(repoRoot, "packages", "coding-agent");
const checks = [
	{
		name: "Nikoflow behavioral suite",
		command: ["bun", "test", "src/nikoflow/__tests__", "test/nikoflow-command.test.ts"],
	},
	{
		name: "Coding-agent static checks",
		command: ["bun", "run", "check"],
	},
] as const;

console.log("[nikoflow-preview] START");
for (const check of checks) {
	console.log(`[nikoflow-preview] GATE ${check.name}`);
	const child = Bun.spawn(check.command, {
		cwd: codingAgent,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		console.error(`[nikoflow-preview] FAIL ${check.name} (exit ${exitCode})`);
		process.exit(exitCode);
	}
	console.log(`[nikoflow-preview] PASS ${check.name}`);
}
console.log("[nikoflow-preview] FINISH all hard gates passed");
