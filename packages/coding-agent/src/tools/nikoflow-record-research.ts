import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import {
	NIKOFLOW_RECORD_RESEARCH_TOOL_NAME,
	type NikoflowResearchRecordInput,
	type NikoflowResearchRecordResult,
} from "../nikoflow/research";
import type { ToolSession } from "../sdk";

const Hypothesis = type({
	claim: "string",
	status: '"supported" | "refuted" | "inconclusive"',
});
const Evidence = type({
	source: '"code" | "project" | "runtime" | "web"',
	locator: "string",
	observation: "string",
});
const nikoflowResearchSchema = type({
	title: "string",
	hypotheses: Hypothesis.array().atLeastLength(1),
	evidence: Evidence.array().atLeastLength(1),
	contradictions: "string[]",
	open_questions: "string[]",
	decision: "string",
}).describe("capture a durable Nikoflow Research evidence bundle");

type NikoflowResearchParams = typeof nikoflowResearchSchema.infer;

export interface NikoflowResearchDetails {
	record: NikoflowResearchRecordInput | null;
	stored: boolean;
	errors?: string[];
}

function renderResult(result: NikoflowResearchRecordResult): AgentToolResult<NikoflowResearchDetails> {
	const failed = result.errors.length > 0;
	return {
		content: [
			{
				type: "text",
				text: failed
					? `Nikoflow Research artifact rejected:\n${result.errors.map(error => `- ${error}`).join("\n")}`
					: `Nikoflow Research artifact captured: ${result.record?.title}.`,
			},
		],
		details: { record: result.record, stored: !failed, ...(failed ? { errors: result.errors } : {}) },
		...(failed ? { isError: true } : {}),
	};
}

export class NikoflowRecordResearchTool implements AgentTool<typeof nikoflowResearchSchema, NikoflowResearchDetails> {
	readonly name = NIKOFLOW_RECORD_RESEARCH_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "Record Nikoflow Research";
	readonly summary = "Capture an evidence-backed Nikoflow Research artifact";
	readonly description =
		"Capture the completed Research bundle. Include hypotheses, code/project/runtime/web evidence locators, contradictions, remaining questions, and the decision. Only available during Nikoflow Research.";
	readonly parameters = nikoflowResearchSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: NikoflowResearchParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<NikoflowResearchDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<NikoflowResearchDetails>> {
		const record = this.session.recordNikoflowResearch;
		if (!record) {
			return renderResult({ record: null, errors: ["Nikoflow Research capture is unavailable in this session"] });
		}
		return renderResult(record(params as NikoflowResearchRecordInput));
	}
}
