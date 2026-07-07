import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assessContextThinness } from "../context-thinness";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "nikoflow-thin-"));
	roots.push(root);
	return root;
}

async function write(root: string, relative: string, content = "export {};\n"): Promise<void> {
	await Bun.write(path.join(root, relative), content);
}

async function git(root: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("assessContextThinness", () => {
	test("treats an empty vague task as thin", async () => {
		const root = await tempRoot();

		const result = assessContextThinness(root, "build me a thing");

		expect(result.thin).toBe(true);
		expect(result.signals.sourceFileCount).toBe(0);
		expect(result.signals.hasReadmeOrDocs).toBe(false);
	});

	test("does not prompt on a pasted spec", async () => {
		const root = await tempRoot();
		const task = "x".repeat(300);

		expect(assessContextThinness(root, task).thin).toBe(false);
	});

	test("does not prompt on a rich repo with README", async () => {
		const root = await tempRoot();
		await write(root, "README.md", "# docs\n");
		for (let i = 0; i < 30; i++) await write(root, `src/file-${i}.ts`);

		const result = assessContextThinness(root, "build me a thing");

		expect(result.thin).toBe(false);
		expect(result.signals.sourceFileCount).toBe(25);
		expect(result.signals.hasReadmeOrDocs).toBe(true);
	});

	test("treats a tiny young repo and vague task as thin", async () => {
		const root = await tempRoot();
		await git(root, ["init"]);
		await git(root, ["config", "user.email", "test@example.test"]);
		await git(root, ["config", "user.name", "Test"]);
		for (let i = 0; i < 8; i++) await write(root, `src/file-${i}.ts`);
		await git(root, ["add", "."]);
		await git(root, ["commit", "-m", "one"]);
		await write(root, "src/after.ts");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-m", "two"]);

		const result = assessContextThinness(root, "build me a thing");

		expect(result.thin).toBe(true);
		expect(result.signals.commitCount).toBe(2);
	});

	test("caps source scan at 25 files", async () => {
		const root = await tempRoot();
		for (let i = 0; i < 1_000; i++) await write(root, `src/file-${i}.ts`);

		expect(assessContextThinness(root, "build me a thing").signals.sourceFileCount).toBe(25);
	});
});
