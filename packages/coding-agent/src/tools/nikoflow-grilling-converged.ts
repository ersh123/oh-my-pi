import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { NIKOFLOW_GRILLING_CONVERGED_TOOL_NAME } from "../nikoflow/gates";
import nikoflowGrillingConvergedDescription from "../prompts/tools/nikoflow-grilling-converged.md" with {
	type: "text",
};

const nikoflowGrillingConvergedSchema = type({
	open_questions: type("string").array().describe("material questions that are still unresolved"),
	assumptions: type("string").array().describe("explicit assumptions made to close grilling"),
	risks: type("string").array().describe("known risks that remain after grilling"),
}).describe("record Nikoflow grilling convergence");

type NikoflowGrillingConvergedParams = typeof nikoflowGrillingConvergedSchema.infer;

export interface NikoflowGrillingConvergedDetails {
	openQuestions: string[];
	assumptions: string[];
	risks: string[];
	accepted: boolean;
}

function cleanList(values: readonly string[]): string[] {
	return values.map(value => value.trim()).filter(Boolean);
}

function renderResult(details: NikoflowGrillingConvergedDetails): AgentToolResult<NikoflowGrillingConvergedDetails> {
	if (!details.accepted) {
		return {
			content: [
				{
					type: "text",
					text: `Nikoflow grilling convergence rejected; resolve open questions first:\n${details.openQuestions.map(question => `- ${question}`).join("\n")}`,
				},
			],
			details,
			isError: true,
		};
	}

	return {
		content: [
			{
				type: "text",
				text: "Nikoflow grilling convergence recorded.",
			},
		],
		details,
	};
}

export class NikoflowGrillingConvergedTool
	implements AgentTool<typeof nikoflowGrillingConvergedSchema, NikoflowGrillingConvergedDetails>
{
	readonly name = NIKOFLOW_GRILLING_CONVERGED_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "Nikoflow Grilling Converged";
	readonly summary = "Record Nikoflow grilling convergence";
	readonly description = prompt.render(nikoflowGrillingConvergedDescription);
	readonly parameters = nikoflowGrillingConvergedSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly loadMode = "essential";

	async execute(
		_toolCallId: string,
		params: NikoflowGrillingConvergedParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<NikoflowGrillingConvergedDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<NikoflowGrillingConvergedDetails>> {
		const openQuestions = cleanList(params.open_questions);
		return renderResult({
			openQuestions,
			assumptions: cleanList(params.assumptions),
			risks: cleanList(params.risks),
			accepted: openQuestions.length === 0,
		});
	}
}
