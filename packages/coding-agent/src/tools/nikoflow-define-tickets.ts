import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import {
	NIKOFLOW_DEFINE_TICKETS_TOOL_NAME,
	type NikoflowTicket,
	type NikoflowTicketDefinitionResult,
	type NikoflowTicketInput,
} from "../nikoflow/tickets";
import nikoflowDefineTicketsDescription from "../prompts/tools/nikoflow-define-tickets.md" with { type: "text" };
import type { ToolSession } from "../sdk";

const TicketDefinition = type({
	id: type("string").describe("stable ticket id, for example TSK-001"),
	acceptance: type("string").array().atLeastLength(1).describe("acceptance criteria for this ticket"),
	blocked_by: type("string").array().describe("ticket ids that must be done first"),
	implementation_notes: type("string").describe("implementation guidance for this ticket"),
});

const nikoflowDefineTicketsSchema = type({
	tickets: TicketDefinition.array().atLeastLength(1).describe("complete dependency DAG for Nikoflow execution"),
}).describe("capture the Nikoflow ticket DAG");

type NikoflowDefineTicketsParams = typeof nikoflowDefineTicketsSchema.infer;

export interface NikoflowDefineTicketsDetails {
	tickets: NikoflowTicket[];
	stored: boolean;
	errors?: string[];
}

function renderResult(
	result: NikoflowTicketDefinitionResult,
	options: { nikoflowActivated?: boolean } = {},
): AgentToolResult<NikoflowDefineTicketsDetails> {
	const failed = result.errors.length > 0;
	const details: NikoflowDefineTicketsDetails = {
		tickets: result.tickets,
		stored: !failed,
	};
	if (failed) details.errors = result.errors;

	return {
		content: [
			{
				type: "text",
				text: failed
					? `Nikoflow ticket DAG rejected:\n${result.errors.map(error => `- ${error}`).join("\n")}${
							result.errors.some(error => error.startsWith("Nikoflow mode is not active"))
								? options.nikoflowActivated
									? "\n\nNikoflow was enabled in the current interactive session. Continue through its gates before defining the ticket DAG again."
									: "\n\nNikoflow activation requires a human decision in the current interactive TUI."
								: ""
						}`
					: `Nikoflow ticket DAG captured: ${result.tickets.length} ticket(s).`,
			},
		],
		details,
		isError: failed ? true : undefined,
	};
}

export class NikoflowDefineTicketsTool
	implements AgentTool<typeof nikoflowDefineTicketsSchema, NikoflowDefineTicketsDetails>
{
	readonly name = NIKOFLOW_DEFINE_TICKETS_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "Define Nikoflow Tickets";
	readonly summary = "Capture the Nikoflow Ticketization DAG";
	readonly description: string;
	readonly parameters = nikoflowDefineTicketsSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(nikoflowDefineTicketsDescription);
	}

	async execute(
		_toolCallId: string,
		params: NikoflowDefineTicketsParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<NikoflowDefineTicketsDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<NikoflowDefineTicketsDetails>> {
		const define = this.session.defineNikoflowTickets;
		if (!define) {
			return renderResult({ tickets: [], errors: ["Nikoflow ticket capture is unavailable in this session"] });
		}
		const result = define(params.tickets as NikoflowTicketInput[]);
		const nikoflowActivated = result.errors.some(error => error.startsWith("Nikoflow mode is not active"))
			? await this.session.requestNikoflowActivation?.()
			: false;
		return renderResult(result, { nikoflowActivated });
	}
}
