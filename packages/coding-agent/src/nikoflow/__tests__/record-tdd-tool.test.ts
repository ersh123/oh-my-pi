import { describe, expect, test } from "bun:test";
import type { ToolSession } from "../../sdk";
import { NikoflowRecordTddTool } from "../../tools/nikoflow-record-tdd";
import type { NikoflowTddEvidenceStage } from "../tickets";

describe("nikoflow_record_tdd tool", () => {
	test("maps RED input into the gate-bound session contract", async () => {
		const recorded: NikoflowTddEvidenceStage[] = [];
		const session = {
			recordNikoflowTddEvidence(stage: NikoflowTddEvidenceStage) {
				recorded.push(stage);
				return {
					evidence: {
						ticketId: stage.ticketId,
						gateId: stage.gateId,
						red: {
							command: "bun test focused.test.ts",
							exitCode: 1,
							expectedFailure: "feature absent",
							recordedAt: 1,
						},
					},
					errors: [],
				};
			},
		} satisfies Partial<ToolSession>;
		const tool = new NikoflowRecordTddTool(session as unknown as ToolSession);

		const result = await tool.execute("call-1", {
			stage: "red",
			ticket_id: "TSK-001",
			gate_id: "gate-1",
			command: "bun test focused.test.ts",
			exit_code: 1,
			expected_failure: "feature absent",
		});

		expect(result.isError).toBeUndefined();
		expect(recorded).toEqual([
			{
				stage: "red",
				ticketId: "TSK-001",
				gateId: "gate-1",
				command: "bun test focused.test.ts",
				exitCode: 1,
				expectedFailure: "feature absent",
			},
		]);
	});

	test("rejects incomplete evidence before touching session state", async () => {
		let called = false;
		const session = {
			recordNikoflowTddEvidence() {
				called = true;
				return { evidence: null, errors: [] };
			},
		} satisfies Partial<ToolSession>;
		const tool = new NikoflowRecordTddTool(session as unknown as ToolSession);

		const result = await tool.execute("call-2", {
			stage: "green",
			ticket_id: "TSK-001",
			gate_id: "gate-1",
		});

		expect(result.isError).toBe(true);
		expect(called).toBe(false);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("command and exit_code");
	});
});
