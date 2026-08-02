import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { normalizeNikoflowCommandArgs } from "@oh-my-pi/pi-coding-agent/cli/nikoflow-command";
import { isSubcommand } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	collectNikoflowModelRoleSelections,
	type NikoflowRolePickerRequest,
	shouldPromptNikoflowModelRoles,
} from "@oh-my-pi/pi-coding-agent/nikoflow/role-picker";
import type { NikoflowRole } from "@oh-my-pi/pi-coding-agent/nikoflow/state";

function makeModel(id: string, options: { reasoning?: boolean; cost?: number } = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: options.reasoning ?? false,
		input: ["text"],
		cost: {
			input: options.cost ?? 1,
			output: options.cost ?? 1,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<Api>;
}

describe("nikoflow command", () => {
	test("is registered as a top-level command", () => {
		expect(isSubcommand("nikoflow")).toBe(true);
		expect(isSubcommand("nflow")).toBe(true);
	});

	test("defaults to max depth without changing launch args", () => {
		expect(normalizeNikoflowCommandArgs(["--model", "gpt", "fix"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["--model", "gpt", "fix"],
		});
	});

	test("accepts positional and flag depth forms", () => {
		expect(normalizeNikoflowCommandArgs(["max", "fix"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["fix"],
		});
		expect(normalizeNikoflowCommandArgs(["light", "build", "small feature"])).toEqual({
			depth: "light",
			autonomous: true,
			grillingMode: null,
			argv: ["build", "small feature"],
		});
		expect(normalizeNikoflowCommandArgs(["--depth=max", "-p", "audit"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["-p", "audit"],
		});
	});

	test("rejects removed depth names", () => {
		expect(normalizeNikoflowCommandArgs(["tactical", "fix"])).toEqual({
			error: "Invalid Nikoflow depth: tactical. Use light, max, research.",
		});
		expect(normalizeNikoflowCommandArgs(["--depth=deep", "fix"])).toEqual({
			error: "Invalid Nikoflow depth: deep. Use light, max, research.",
		});
		expect(normalizeNikoflowCommandArgs(["--depth", "standard", "fix"])).toEqual({
			error: "Invalid Nikoflow depth: standard. Use light, max, research.",
		});
	});

	test("accepts research depth in positional and flag forms", () => {
		expect(normalizeNikoflowCommandArgs(["research", "fix"])).toEqual({
			depth: "research",
			autonomous: true,
			grillingMode: null,
			argv: ["fix"],
		});
		expect(normalizeNikoflowCommandArgs(["--depth", "research", "fix"])).toEqual({
			depth: "research",
			autonomous: true,
			grillingMode: null,
			argv: ["fix"],
		});
		expect(normalizeNikoflowCommandArgs(["--depth=research", "fix"])).toEqual({
			depth: "research",
			autonomous: true,
			grillingMode: null,
			argv: ["fix"],
		});
	});

	test("accepts batch before positional depth", () => {
		expect(normalizeNikoflowCommandArgs(["--batch", "max", "fix"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["fix"],
		});
	});

	test("normalizes grilling mode flags while preserving pass-through ordering", () => {
		expect(normalizeNikoflowCommandArgs(["--interview", "--model", "gpt", "fix"])).toEqual({
			depth: "max",
			autonomous: false,
			grillingMode: "interview",
			argv: ["--nikoflow-grilling", "interview", "--model", "gpt", "fix"],
		});
		expect(normalizeNikoflowCommandArgs(["--brief", "max", "fix"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: "brief",
			argv: ["--nikoflow-grilling", "brief", "fix"],
		});
	});

	test("rejects deep interview batch normalization", () => {
		expect(normalizeNikoflowCommandArgs(["--interview", "--batch", "fix"])).toEqual({
			error: "Deep interview requires an interactive human; drop --interview or --batch.",
		});
		expect(normalizeNikoflowCommandArgs(["--brief", "--batch", "fix"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: "brief",
			argv: ["--nikoflow-grilling", "brief", "fix"],
		});
	});

	test("does not let prompt text override explicit depth", () => {
		expect(normalizeNikoflowCommandArgs(["--depth", "max", "deep", "fix"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["deep", "fix"],
		});
		expect(normalizeNikoflowCommandArgs(["--depth=max", "standard", "fix"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["standard", "fix"],
		});
	});

	test("maps nikoflow role flags onto launch model-role flags", () => {
		expect(
			normalizeNikoflowCommandArgs(["--exec=cheap", "--architect", "strong-plan", "--qa", "strong-qa", "fix"]),
		).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["--model", "cheap", "--plan", "strong-plan", "--nikoflow-qa", "strong-qa", "fix"],
		});
	});

	test("picker fills missing nikoflow roles", async () => {
		const models = [makeModel("cheap", { cost: 0.1 }), makeModel("strong", { reasoning: true, cost: 3 })];
		const asked: NikoflowRole[] = [];
		const settings = Settings.isolated();
		const selections = await collectNikoflowModelRoleSelections({
			args: {},
			settings,
			models,
			pick: async (request: NikoflowRolePickerRequest) => {
				asked.push(request.role);
				return request.role === "default" ? "test/cheap" : "test/strong";
			},
		});

		expect(asked).toEqual(["plan", "default", "advisor"]);
		expect(selections.plan?.selector).toBe("test/strong");
		expect(selections.default?.selector).toBe("test/cheap");
		expect(selections.advisor?.selector).toBe("test/strong");
	});

	test("role flag overrides picker for that role", async () => {
		const models = [makeModel("cheap"), makeModel("strong", { reasoning: true })];
		const asked: NikoflowRole[] = [];
		const settings = Settings.isolated({ modelRoles: { plan: "test/flag-plan" } });
		const selections = await collectNikoflowModelRoleSelections({
			args: { plan: "test/flag-plan" },
			settings,
			models,
			pick: async (request: NikoflowRolePickerRequest) => {
				asked.push(request.role);
				return request.role === "default" ? "test/cheap" : "test/strong";
			},
		});

		expect(asked).toEqual(["default", "advisor"]);
		expect(selections.plan).toBeUndefined();
		expect(selections.default?.selector).toBe("test/cheap");
		expect(selections.advisor?.selector).toBe("test/strong");
	});

	test("rejects architect and executor picking the same model", async () => {
		const models = [makeModel("same", { reasoning: true }), makeModel("qa", { reasoning: true })];
		const settings = Settings.isolated();

		await expect(
			collectNikoflowModelRoleSelections({
				args: {},
				settings,
				models,
				pick: async (request: NikoflowRolePickerRequest) => (request.role === "advisor" ? "test/qa" : "test/same"),
			}),
		).rejects.toThrow("Architect to differ from Executor");
	});

	test("print and non-tty nikoflow runs skip picker", () => {
		const runtime = { interactive: true, stdinIsTTY: true, stdoutIsTTY: true };
		expect(shouldPromptNikoflowModelRoles({ nikoflowDepth: "max", print: true }, runtime)).toBe(false);
		expect(
			shouldPromptNikoflowModelRoles(
				{ nikoflowDepth: "max" },
				{ interactive: true, stdinIsTTY: false, stdoutIsTTY: true },
			),
		).toBe(false);
	});
});
