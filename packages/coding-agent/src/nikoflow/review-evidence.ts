interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function section(title: string, body: string): string {
	return `${title}\n${body.trim() || "(empty)"}`;
}

function failedSection(title: string, result: GitResult): string {
	return `${title}\nfailed: ${result.stderr.trim() || `exit ${result.exitCode}`}`;
}

async function committedDiff(cwd: string): Promise<string | null> {
	const upstream = await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	const upstreamRef = upstream.exitCode === 0 ? upstream.stdout.trim() : "";
	if (upstreamRef) {
		const diff = await runGit(cwd, ["diff", "--no-ext-diff", `${upstreamRef}...HEAD`, "--"]);
		if (diff.exitCode !== 0) return failedSection(`git diff --no-ext-diff ${upstreamRef}...HEAD --`, diff);
		return diff.stdout.trim() ? section(`git diff --no-ext-diff ${upstreamRef}...HEAD --`, diff.stdout) : null;
	}

	const parent = await runGit(cwd, ["rev-parse", "--verify", "HEAD^"]);
	if (parent.exitCode !== 0) return null;
	const show = await runGit(cwd, ["show", "--no-ext-diff", "--stat", "--patch", "--format=medium", "HEAD", "--"]);
	if (show.exitCode !== 0) return failedSection("git show --no-ext-diff --stat --patch HEAD --", show);
	return show.stdout.trim() ? section("git show --no-ext-diff --stat --patch HEAD --", show.stdout) : null;
}

async function untrackedPatches(cwd: string): Promise<string | null> {
	const files = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (files.exitCode !== 0) return failedSection("git ls-files --others --exclude-standard -z", files);
	const paths = files.stdout.split("\0").filter(Boolean);
	if (paths.length === 0) return null;
	const patches: string[] = [];
	for (const filePath of paths) {
		const diff = await runGit(cwd, ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", filePath]);
		if (diff.exitCode !== 0 && diff.exitCode !== 1) {
			patches.push(failedSection(`git diff --no-ext-diff --no-index -- /dev/null ${filePath}`, diff));
			continue;
		}
		patches.push(section(`git diff --no-ext-diff --no-index -- /dev/null ${filePath}`, diff.stdout));
	}
	return patches.join("\n\n");
}

export async function collectNikoflowReviewDiff(cwd: string): Promise<string> {
	const status = await runGit(cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]);
	const headDiff = await runGit(cwd, ["diff", "--no-ext-diff", "HEAD", "--"]);
	const sections = [
		status.exitCode === 0
			? section("git status --porcelain=v1 --branch --untracked-files=all", status.stdout)
			: failedSection("git status --porcelain=v1 --branch --untracked-files=all", status),
		headDiff.exitCode === 0
			? section("git diff --no-ext-diff HEAD --", headDiff.stdout)
			: failedSection("git diff --no-ext-diff HEAD --", headDiff),
	];
	const committed = await committedDiff(cwd);
	if (committed) sections.push(committed);
	const untracked = await untrackedPatches(cwd);
	if (untracked) sections.push(untracked);
	return sections.join("\n\n");
}
