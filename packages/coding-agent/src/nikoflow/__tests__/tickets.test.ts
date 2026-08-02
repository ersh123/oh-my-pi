import { describe, expect, test } from "bun:test";
import {
	getNextTicket,
	invalidateNikoflowTddGreen,
	isNikoflowTddEvidenceComplete,
	markStatus,
	type NikoflowTicket,
	normalizeDefinedTickets,
	parseTicketTodoContent,
	recordNikoflowTddEvidence,
	ticketDagFromTodoPhases,
	validateTicketDag,
} from "../tickets";

const ticket = (id: string, blocked_by: string[] = [], status: NikoflowTicket["status"] = "todo"): NikoflowTicket => ({
	id,
	acceptance: [`${id} works`],
	blocked_by,
	implementation_notes: `${id} notes`,
	status,
});

describe("nikoflow tickets", () => {
	test("validates dangling deps, duplicate ids, and cycles", () => {
		expect(validateTicketDag([ticket("TSK-001"), ticket("TSK-002", ["TSK-001"])]).ok).toBe(true);

		const dangling = validateTicketDag([ticket("TSK-001", ["MISSING"])]);
		expect(dangling.ok).toBe(false);
		expect(dangling.errors.join("\n")).toContain("unknown ticket MISSING");

		const duplicate = validateTicketDag([ticket("TSK-001"), ticket("TSK-001")]);
		expect(duplicate.ok).toBe(false);
		expect(duplicate.errors.join("\n")).toContain("unique");

		const cycle = validateTicketDag([ticket("TSK-001", ["TSK-002"]), ticket("TSK-002", ["TSK-001"])]);
		expect(cycle.ok).toBe(false);
		expect(cycle.errors.join("\n")).toContain("dependency cycle");
	});

	test("returns the first unblocked unfinished ticket", () => {
		const tickets = [ticket("TSK-001", [], "done"), ticket("TSK-002", ["TSK-001"]), ticket("TSK-003", ["TSK-002"])];
		expect(getNextTicket(tickets)?.id).toBe("TSK-002");
		expect(getNextTicket(markStatus(tickets, "TSK-002", "done"))?.id).toBe("TSK-003");
		expect(getNextTicket(markStatus(markStatus(tickets, "TSK-002", "done"), "TSK-003", "done"))).toBeNull();
	});

	test("marks status immutably", () => {
		const tickets = [ticket("TSK-001")];
		const updated = markStatus(tickets, "TSK-001", "green");
		expect(updated).not.toBe(tickets);
		expect(updated[0]).not.toBe(tickets[0]);
		expect(tickets[0].status).toBe("todo");
		expect(updated[0].status).toBe("green");
	});

	test("rejects fields that would corrupt todo-state round trips", () => {
		const result = normalizeDefinedTickets([
			{
				id: "TSK:001",
				acceptance: ["a | b", " notes="],
				blocked_by: ["TSK,000"],
				implementation_notes: "keep notes=hostile",
			},
		]);

		expect(result.errors.join("\n")).toContain("id must match ^[A-Za-z0-9_-]+$");
		expect(result.errors.join("\n")).toContain("acceptance 1 contains a reserved todo delimiter");
		expect(result.errors.join("\n")).toContain("acceptance 2 contains a reserved todo delimiter");
		expect(result.errors.join("\n")).toContain("blocked_by TSK,000 must match ^[A-Za-z0-9_-]+$");
		expect(result.errors.join("\n")).toContain("implementation_notes contains a reserved todo delimiter");
	});

	test("parses ticket DAG from todo state", () => {
		expect(
			parseTicketTodoContent(
				"TSK-002: blocked_by=TSK-001 acceptance=Given A | Then B notes=touch one file",
				"in_progress",
			),
		).toEqual({
			id: "TSK-002",
			acceptance: ["Given A", "Then B"],
			blocked_by: ["TSK-001"],
			implementation_notes: "touch one file",
			status: "review",
		});

		const tickets = ticketDagFromTodoPhases([
			{
				name: "Nikoflow Tickets",
				tasks: [
					{ content: "TSK-001: acceptance=base works notes=base", status: "completed" },
					{ content: "TSK-002: blocked_by=TSK-001 acceptance=next works notes=next", status: "pending" },
				],
			},
		]);
		expect(validateTicketDag(tickets).ok).toBe(true);
		expect(tickets.map(item => [item.id, item.status])).toEqual([
			["TSK-001", "done"],
			["TSK-002", "todo"],
		]);
	});

	test("binds GREEN to the exact RED command, ticket, and gate", () => {
		const red = recordNikoflowTddEvidence(
			null,
			{
				stage: "red",
				ticketId: "TSK-001",
				gateId: "gate-1",
				command: "bun test focused",
				exitCode: 1,
				expectedFailure: "expected assertion",
			},
			10,
		);
		expect(red.errors).toEqual([]);
		expect(
			recordNikoflowTddEvidence(red.evidence, {
				stage: "green",
				ticketId: "TSK-001",
				gateId: "gate-1",
				command: "bun test other",
				exitCode: 0,
			}).errors,
		).toContain("GREEN command must exactly match the recorded RED command");

		const green = recordNikoflowTddEvidence(
			red.evidence,
			{
				stage: "green",
				ticketId: "TSK-001",
				gateId: "gate-1",
				command: "bun test focused",
				exitCode: 0,
			},
			20,
		);
		expect(green.errors).toEqual([]);
		expect(isNikoflowTddEvidenceComplete(green.evidence, "TSK-001", "gate-1")).toBe(true);
		expect(isNikoflowTddEvidenceComplete(green.evidence, "TSK-001", "gate-2")).toBe(false);
	});

	test("supports an explicit waiver and invalidates GREEN without discarding RED", () => {
		const waiver = recordNikoflowTddEvidence(
			null,
			{ stage: "waiver", ticketId: "TSK-001", gateId: "gate-1", reason: "documentation-only ticket" },
			10,
		);
		expect(waiver.errors).toEqual([]);
		expect(waiver.evidence?.red).toBeUndefined();
		expect(waiver.evidence?.green).toBeUndefined();
		expect(isNikoflowTddEvidenceComplete(waiver.evidence, "TSK-001", "gate-1")).toBe(true);

		const complete = {
			ticketId: "TSK-001",
			gateId: "gate-1",
			red: { command: "bun test focused", exitCode: 1, expectedFailure: "expected", recordedAt: 1 },
			green: { command: "bun test focused", exitCode: 0, recordedAt: 2 },
		};
		expect(invalidateNikoflowTddGreen(complete)).toEqual({
			ticketId: "TSK-001",
			gateId: "gate-1",
			red: complete.red,
		});
	});
});
