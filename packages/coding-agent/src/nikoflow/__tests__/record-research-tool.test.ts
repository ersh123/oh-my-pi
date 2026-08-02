import { describe, expect, test } from "bun:test";
import type { ToolSession } from "../../sdk";
import { NikoflowRecordResearchTool } from "../../tools/nikoflow-record-research";
import { type NikoflowResearchRecordInput, normalizeNikoflowResearchRecord } from "../research";

const record: NikoflowResearchRecordInput = {
	title: "Search lifecycle",
	hypotheses: [{ claim: "The wrapper forwards an unsupported flag", status: "supported" }],
	evidence: [{ source: "code", locator: "search-mcp.py:76", observation: "--num is forwarded" }],
	contradictions: [],
	open_questions: [],
	decision: "Remove the unsupported forwarding.",
};

const toolParams = {
	...record,
	hypotheses: [...record.hypotheses],
	evidence: [...record.evidence],
	contradictions: [...record.contradictions],
	open_questions: [...record.open_questions],
};

describe("nikoflow_record_research tool", () => {
	test("captures a structured durable Research record", async () => {
		const persisted: NikoflowResearchRecordInput[] = [];
		const session = {
			recordNikoflowResearch(input: NikoflowResearchRecordInput) {
				const result = normalizeNikoflowResearchRecord(input);
				if (result.record) persisted.push(result.record);
				return result;
			},
		} satisfies Partial<ToolSession>;

		const result = await new NikoflowRecordResearchTool(session as unknown as ToolSession).execute(
			"call-1",
			toolParams,
		);

		expect(result.isError).toBeUndefined();
		expect(result.details?.stored).toBe(true);
		expect(persisted).toEqual([record]);
	});

	test("reports a phase rejection without claiming persistence", async () => {
		const session = {
			recordNikoflowResearch() {
				return { record: null, errors: ["nikoflow_record_research can only run during Research"] };
			},
		} satisfies Partial<ToolSession>;

		const result = await new NikoflowRecordResearchTool(session as unknown as ToolSession).execute(
			"call-1",
			toolParams,
		);

		expect(result.isError).toBe(true);
		expect(result.details?.stored).toBe(false);
	});
});
