import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../cli/args";
import { normalizeNikoflowCommandArgs } from "../../cli/nikoflow-command";
import { rejectNikoflowInNonInteractiveMode } from "../../main";
import { parseNikoflowKeywordInput, tryHandleNikoflowKeywordInput } from "../../modes/controllers/input-controller";

describe("nikoflow CLI activation guard", () => {
	test("rejects nikoflow in print or non-interactive mode", () => {
		expect(() => rejectNikoflowInNonInteractiveMode("niko flow:max do it")).toThrow(
			"Nikoflow requires interactive mode",
		);
		expect(() => rejectNikoflowInNonInteractiveMode(undefined, "light")).toThrow(
			"Nikoflow requires interactive mode",
		);
		expect(() => rejectNikoflowInNonInteractiveMode("plain prompt")).not.toThrow();
	});

	test("allows nikoflow in non-interactive batch mode", () => {
		expect(() => rejectNikoflowInNonInteractiveMode("niko flow:max do it", undefined, true)).not.toThrow();
	});

	test("parses the nikoflow batch flag into root args", () => {
		expect(normalizeNikoflowCommandArgs(["--batch", "max", "ship it"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["ship it"],
		});

		const parsed = parseArgs([
			"--nikoflow-depth",
			"max",
			"--nikoflow-batch",
			"--nikoflow-grilling",
			"brief",
			"ship it",
		]);
		expect(parsed.nikoflowDepth).toBe("max");
		expect(parsed.nikoflowBatch).toBe(true);
		expect(parsed.nikoflowGrilling).toBe("brief");
		expect(parsed.messages).toEqual(["ship it"]);
	});

	test("defaults Nikoflow commands to autonomous batch execution", () => {
		expect(normalizeNikoflowCommandArgs(["max", "ship it"])).toEqual({
			depth: "max",
			autonomous: true,
			grillingMode: null,
			argv: ["ship it"],
		});
		expect(normalizeNikoflowCommandArgs(["--interactive", "max", "review it"])).toEqual({
			depth: "max",
			autonomous: false,
			grillingMode: null,
			argv: ["review it"],
		});
	});

	test("rejects deep interview in batch mode", () => {
		expect(() => rejectNikoflowInNonInteractiveMode("niko flow:max do it", undefined, true, "interview")).toThrow(
			"Deep interview requires an interactive human",
		);
		expect(() => rejectNikoflowInNonInteractiveMode("niko flow:max do it", undefined, true, "brief")).not.toThrow();
	});

	test("parses first-token nikoflow keywords into command rest", () => {
		expect(parseNikoflowKeywordInput("nikoflow:max build Y")).toEqual({ rest: "max build Y" });
		expect(parseNikoflowKeywordInput("nikoflow:light build small Y")).toEqual({ rest: "light build small Y" });
		expect(parseNikoflowKeywordInput("nikoflow:research build insights")).toEqual({
			rest: "research build insights",
		});
		expect(parseNikoflowKeywordInput("никофлоу:max --batch Z")).toEqual({
			rest: "max --batch Z",
		});
		expect(parseNikoflowKeywordInput("nikoflow:wrong build Y")).toEqual({
			error: "Invalid Nikoflow depth: wrong. Use light, max, research.",
		});
		expect(parseNikoflowKeywordInput("please run nikoflow")).toBeUndefined();
	});

	test("consumes nikoflow keyword submissions before normal prompting", async () => {
		const activations: string[] = [];
		const handled = await tryHandleNikoflowKeywordInput(
			"никофлоу разработай X",
			{
				handleNikoflowCommand: async rest => {
					activations.push(rest ?? "");
				},
				showWarning: () => {
					throw new Error("unexpected warning");
				},
			},
			{ hasImages: false },
		);

		expect(handled).toBe(true);
		expect(activations).toEqual(["разработай X"]);

		const normalHandled = await tryHandleNikoflowKeywordInput(
			"обычный запрос nikoflow",
			{
				handleNikoflowCommand: async rest => {
					activations.push(rest ?? "");
				},
				showWarning: () => {
					throw new Error("unexpected warning");
				},
			},
			{ hasImages: false },
		);
		expect(normalHandled).toBe(false);
		expect(activations).toEqual(["разработай X"]);
	});

	test("does not consume nikoflow keyword mentions while a flow is active", async () => {
		const handled = await tryHandleNikoflowKeywordInput(
			"nikoflow keep working from the current ticket",
			{
				handleNikoflowCommand: async () => {
					throw new Error("must stay on the normal prompt path");
				},
				showWarning: () => {
					throw new Error("unexpected warning");
				},
			},
			{ hasImages: false, nikoflowActive: true },
		);

		expect(handled).toBe(false);
	});
});
