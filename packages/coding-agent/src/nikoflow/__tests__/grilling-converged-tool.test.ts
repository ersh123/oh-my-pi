import { describe, expect, test } from "bun:test";
import { NikoflowGrillingConvergedTool } from "../../tools/nikoflow-grilling-converged";

describe("nikoflow_grilling_converged tool", () => {
	test("records convergence when no open questions remain", async () => {
		const tool = new NikoflowGrillingConvergedTool();
		const result = await tool.execute("call-1", {
			open_questions: [],
			assumptions: ["scope is limited"],
			risks: ["tests may fail"],
		});

		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({
			openQuestions: [],
			assumptions: ["scope is limited"],
			risks: ["tests may fail"],
			accepted: true,
		});
	});

	test("rejects convergence while questions remain open", async () => {
		const tool = new NikoflowGrillingConvergedTool();
		const result = await tool.execute("call-1", {
			open_questions: ["Which command proves this?"],
			assumptions: [],
			risks: [],
		});

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			openQuestions: ["Which command proves this?"],
			assumptions: [],
			risks: [],
			accepted: false,
		});
	});
});
