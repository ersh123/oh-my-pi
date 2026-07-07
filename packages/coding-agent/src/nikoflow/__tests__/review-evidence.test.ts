import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectNikoflowReviewDiff } from "../review-evidence";

function git(cwd: string, args: readonly string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args.join(" ")} failed`);
	}
}

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "nikoflow-review-"));
	try {
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "test@example.com"]);
		git(repo, ["config", "user.name", "Test User"]);
		await Bun.write(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "base.txt"]);
		git(repo, ["commit", "-m", "base"]);
		await run(repo);
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

describe("nikoflow review evidence", () => {
	test("includes committed, staged, and untracked work in the advisor diff surface", async () => {
		await withRepo(async repo => {
			await Bun.write(path.join(repo, "committed.txt"), "committed evidence\n");
			git(repo, ["add", "committed.txt"]);
			git(repo, ["commit", "-m", "committed"]);
			await Bun.write(path.join(repo, "stashed.txt"), "stashed evidence\n");
			git(repo, ["add", "stashed.txt"]);
			git(repo, ["stash", "push", "-m", "hidden work"]);
			await Bun.write(path.join(repo, "staged.txt"), "staged evidence\n");
			git(repo, ["add", "staged.txt"]);
			await Bun.write(path.join(repo, "untracked.txt"), "untracked evidence\n");

			const diff = await collectNikoflowReviewDiff(repo);

			expect(diff).toContain("git status --porcelain");
			expect(diff).toContain("git diff --no-ext-diff HEAD --");
			expect(diff).toContain("git stash list");
			expect(diff).toContain("hidden work");
			expect(diff).toContain("A  staged.txt");
			expect(diff).toContain("?? untracked.txt");
			expect(diff).toContain("+staged evidence");
			expect(diff).toContain("committed.txt");
			expect(diff).toContain("+committed evidence");
			expect(diff).toContain("untracked.txt");
			expect(diff).toContain("+untracked evidence");
		});
	});
});
