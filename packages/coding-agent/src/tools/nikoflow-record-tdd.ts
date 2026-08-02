import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import {
	NIKOFLOW_RECORD_TDD_TOOL_NAME,
	type NikoflowTddEvidence,
	type NikoflowTddEvidenceResult,
	type NikoflowTddEvidenceStage,
} from "../nikoflow/tickets";
import type { ToolSession } from "../sdk";

const nikoflowRecordTddSchema = type({
	stage: type("'red' | 'green' | 'waiver'").describe("which TDD obligation to record"),
	ticket_id: type("string").describe("active Nikoflow ticket id"),
	gate_id: type("string").describe("current execute gate id from nikoflow-context"),
	"command?": type("string").describe("exact focused test command used for RED or GREEN"),
	"exit_code?": type("number.integer").describe("observed command exit code"),
	"expected_failure?": type("string").describe("RED-only explanation of the expected pre-change failure"),
	"reason?": type("string").describe("waiver-only reason for a ticket with no runtime surface"),
}).describe("record gate-bound Nikoflow TDD evidence");

type NikoflowRecordTddParams = typeof nikoflowRecordTddSchema.infer;

export interface NikoflowRecordTddDetails {
	evidence: NikoflowTddEvidence | null;
	stored: boolean;
	errors?: string[];
}

function renderResult(result: NikoflowTddEvidenceResult): AgentToolResult<NikoflowRecordTddDetails> {
	const failed = result.errors.length > 0;
	return {
		content: [
			{
				type: "text",
				text: failed
					? `Nikoflow TDD evidence rejected:\n${result.errors.map(error => `- ${error}`).join("\n")}`
					: "Nikoflow TDD evidence recorded for the current execute gate.",
			},
		],
		details: {
			evidence: result.evidence,
			stored: !failed,
			...(failed ? { errors: result.errors } : {}),
		},
		isError: failed ? true : undefined,
	};
}

function evidenceStage(params: NikoflowRecordTddParams): NikoflowTddEvidenceStage | null {
	const base = { ticketId: params.ticket_id, gateId: params.gate_id };
	if (params.stage === "waiver") {
		return typeof params.reason === "string" ? { ...base, stage: "waiver", reason: params.reason } : null;
	}
	if (typeof params.command !== "string" || typeof params.exit_code !== "number") return null;
	if (params.stage === "red") {
		return typeof params.expected_failure === "string"
			? {
					...base,
					stage: "red",
					command: params.command,
					exitCode: params.exit_code,
					expectedFailure: params.expected_failure,
				}
			: null;
	}
	return { ...base, stage: "green", command: params.command, exitCode: params.exit_code };
}

export class NikoflowRecordTddTool implements AgentTool<typeof nikoflowRecordTddSchema, NikoflowRecordTddDetails> {
	readonly name = NIKOFLOW_RECORD_TDD_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "Record Nikoflow TDD";
	readonly summary = "Record RED, GREEN, or a no-runtime waiver";
	readonly description =
		"Record machine-checkable TDD evidence for the active Nikoflow execute ticket. The ticket and gate ids must match current state. Record a non-zero RED before a zero-exit GREEN, or a reasoned waiver only when the ticket has no runtime surface.";
	readonly parameters = nikoflowRecordTddSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: NikoflowRecordTddParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<NikoflowRecordTddDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<NikoflowRecordTddDetails>> {
		const stage = evidenceStage(params);
		if (!stage) {
			return renderResult({
				evidence: null,
				errors: [
					params.stage === "waiver"
						? "waiver requires reason"
						: `${params.stage} requires command and exit_code${params.stage === "red" ? " plus expected_failure" : ""}`,
				],
			});
		}
		const record = this.session.recordNikoflowTddEvidence;
		return record
			? renderResult(record(stage))
			: renderResult({ evidence: null, errors: ["Nikoflow TDD evidence capture is unavailable"] });
	}
}
