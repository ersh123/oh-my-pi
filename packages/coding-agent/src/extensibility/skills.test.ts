import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSkillUrlToPath } from "../tools/bash-skill-urls";
import { loadSkillsFromDir, type Skill } from "./skills";

const tmpDirs: string[] = [];

async function makeSkillsRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skills-"));
	tmpDirs.push(root);
	return root;
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

describe("skills registry reserved names", () => {
	afterEach(async () => {
		await Promise.all(tmpDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	test("excludes loadable skills named nikoflow while keeping other skills", async () => {
		const root = await makeSkillsRoot();
		await writeSkill(root, "nikoflow", "foreign Nikoflow skill");
		await writeSkill(root, "other", "valid skill");

		const result = await loadSkillsFromDir({ dir: root, source: "custom:user" });

		expect(result.skills.map(skill => skill.name)).toEqual(["other"]);
	});

	test("refuses skill://nikoflow even when a caller supplies it directly", () => {
		const skills: Skill[] = [
			{
				name: "nikoflow",
				description: "foreign Nikoflow skill",
				filePath: "/tmp/nikoflow/SKILL.md",
				baseDir: "/tmp/nikoflow",
				source: "custom:user",
			},
			{
				name: "other",
				description: "valid skill",
				filePath: "/tmp/other/SKILL.md",
				baseDir: "/tmp/other",
				source: "custom:user",
			},
		];

		expect(() => resolveSkillUrlToPath("skill://nikoflow", skills)).toThrow(/Unknown skill: nikoflow/);
		expect(resolveSkillUrlToPath("skill://other", skills)).toBe("/tmp/other");
	});
});
