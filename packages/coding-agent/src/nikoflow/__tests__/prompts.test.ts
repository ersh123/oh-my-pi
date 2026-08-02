import { describe, expect, test } from "bun:test";
import { getCurrentPhaseProtocol, getPhasePrompt } from "../prompts";
import { advancePhase, createState, mintGateRequest } from "../state";

describe("nikoflow prompts", () => {
	test("injects only the current phase protocol", () => {
		const state = mintGateRequest(createState("max"), "g1");
		const prompt = getPhasePrompt(state);
		expect(prompt).toContain("Nikoflow phase: grilling");
		expect(prompt).toContain("Required role: plan");
		expect(prompt).toContain("Mode: interactive");
		expect(prompt).not.toContain("Gate request:");
		expect(prompt).not.toContain("g1");
		expect(prompt).not.toContain("Execute phase");
	});

	test("batch grilling records human-unverified assumptions", () => {
		const prompt = getPhasePrompt(mintGateRequest(createState("max", { autonomous: true }), "g1"));
		expect(prompt).toContain("Mode: batch");
		expect(prompt).toContain("unverified by a human");
		expect(prompt).toContain("nikoflow_grilling_converged");
		expect(prompt).toContain("open_questions: []");
	});

	test("grilling prompt changes only for explicit interactive modes", () => {
		const current = getPhasePrompt(createState("max"));
		const interview = getPhasePrompt(createState("max", { grillingMode: "interview" }));
		const brief = getPhasePrompt(createState("max", { grillingMode: "brief" }));

		expect(current).toContain("Grilling phase. Interrogate the user");
		expect(interview).toContain("there is no existing project context");
		expect(interview).toContain("pinned by an explicit answer");
		expect(brief).toContain("fast scoping pass");
		expect(brief).toContain("Ask only the few questions");
		expect(interview).toContain("open_questions: []");
		expect(brief).toContain("open_questions: []");
		expect(current).not.toBe(interview);
		expect(current).not.toBe(brief);
	});

	test("batch grilling prompt ignores grilling mode", () => {
		const batch = getPhasePrompt(createState("max", { autonomous: true }));
		const interviewBatch = getPhasePrompt(createState("max", { autonomous: true, grillingMode: "interview" }));
		const briefBatch = getPhasePrompt(createState("max", { autonomous: true, grillingMode: "brief" }));

		expect(interviewBatch).toBe(batch);
		expect(briefBatch).toBe(batch);
	});

	test("non-grilling phase prompts ignore grilling mode", () => {
		const adr = getPhasePrompt(advancePhase(createState("max")));
		const interviewAdr = getPhasePrompt(advancePhase(createState("max", { grillingMode: "interview" })));

		expect(interviewAdr).toBe(adr);
	});

	test("switches protocol by phase", () => {
		const execute = advancePhase(advancePhase(advancePhase(createState("light"))));
		expect(getCurrentPhaseProtocol(execute)).toContain("Execute phase");
		expect(getCurrentPhaseProtocol(execute)).toContain("<nikoflow-context>");
	});
});
