export const NIKOFLOW_RECORD_RESEARCH_TOOL_NAME = "nikoflow_record_research";

export const NIKOFLOW_RESEARCH_SOURCE_REALMS = ["code", "project", "runtime", "web"] as const;
export type NikoflowResearchSourceRealm = (typeof NIKOFLOW_RESEARCH_SOURCE_REALMS)[number];
export const NIKOFLOW_RESEARCH_HYPOTHESIS_STATUSES = ["supported", "refuted", "inconclusive"] as const;
export type NikoflowResearchHypothesisStatus = (typeof NIKOFLOW_RESEARCH_HYPOTHESIS_STATUSES)[number];

export interface NikoflowResearchHypothesis {
	claim: string;
	status: NikoflowResearchHypothesisStatus;
}

export interface NikoflowResearchEvidence {
	source: NikoflowResearchSourceRealm;
	locator: string;
	observation: string;
}

export interface NikoflowResearchRecordInput {
	title: string;
	hypotheses: readonly NikoflowResearchHypothesis[];
	evidence: readonly NikoflowResearchEvidence[];
	contradictions: readonly string[];
	open_questions: readonly string[];
	decision: string;
}

export interface NikoflowResearchRecordResult {
	record: NikoflowResearchRecordInput | null;
	errors: string[];
}

export function normalizeNikoflowResearchRecord(input: NikoflowResearchRecordInput): NikoflowResearchRecordResult {
	const errors: string[] = [];
	if (input.title.trim().length === 0) errors.push("title is required");
	if (input.decision.trim().length === 0) errors.push("decision is required");
	if (input.hypotheses.length === 0) errors.push("at least one hypothesis is required");
	if (input.evidence.length === 0) errors.push("at least one evidence item is required");
	input.hypotheses.forEach((hypothesis, index) => {
		if (hypothesis.claim.trim().length === 0) errors.push(`hypotheses[${index}].claim is required`);
		if (!NIKOFLOW_RESEARCH_HYPOTHESIS_STATUSES.includes(hypothesis.status)) {
			errors.push(`hypotheses[${index}].status is invalid`);
		}
	});
	input.evidence.forEach((evidence, index) => {
		if (!NIKOFLOW_RESEARCH_SOURCE_REALMS.includes(evidence.source))
			errors.push(`evidence[${index}].source is invalid`);
		if (evidence.locator.trim().length === 0) errors.push(`evidence[${index}].locator is required`);
		if (evidence.observation.trim().length === 0) errors.push(`evidence[${index}].observation is required`);
	});
	if (errors.length > 0) return { record: null, errors };
	return {
		record: {
			title: input.title.trim(),
			hypotheses: input.hypotheses.map(hypothesis => ({
				claim: hypothesis.claim.trim(),
				status: hypothesis.status,
			})),
			evidence: input.evidence.map(evidence => ({
				source: evidence.source,
				locator: evidence.locator.trim(),
				observation: evidence.observation.trim(),
			})),
			contradictions: input.contradictions.map(value => value.trim()).filter(Boolean),
			open_questions: input.open_questions.map(value => value.trim()).filter(Boolean),
			decision: input.decision.trim(),
		},
		errors: [],
	};
}

export function renderNikoflowResearchMarkdown(record: NikoflowResearchRecordInput): string {
	const list = (items: readonly string[]) =>
		items.length > 0 ? items.map(item => `- ${item}`).join("\n") : "- (none)";
	return [
		`# Research: ${record.title}`,
		"",
		"## Hypotheses",
		...record.hypotheses.map(hypothesis => `- [${hypothesis.status}] ${hypothesis.claim}`),
		"",
		"## Evidence",
		...record.evidence.map(evidence => `- [${evidence.source}] ${evidence.locator}: ${evidence.observation}`),
		"",
		"## Contradictions",
		list(record.contradictions),
		"",
		"## Open questions",
		list(record.open_questions),
		"",
		"## Decision",
		record.decision,
		"",
	].join("\n");
}
