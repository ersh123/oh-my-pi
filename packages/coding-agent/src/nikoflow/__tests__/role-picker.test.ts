import { describe, expect, test, vi } from "bun:test";
import { createInteractiveNikoflowRolePicker, type NikoflowRolePickerRequest } from "../role-picker";

const request: NikoflowRolePickerRequest = {
	role: "plan",
	title: "Architect — strong model",
	initialIndex: 1,
	options: [
		{
			model: {} as never,
			selector: "provider/architect",
			label: "Architect",
			description: "Strong planning model",
		},
		{
			model: {} as never,
			selector: "provider/fallback",
			label: "Fallback",
			description: "Fallback planning model",
		},
	],
};

describe("interactive Nikoflow role picker", () => {
	test("uses the existing interactive selector and maps its label to a model selector", async () => {
		const select = vi.fn(async () => "Fallback");
		const picker = createInteractiveNikoflowRolePicker(select);

		expect(await picker(request)).toBe("provider/fallback");
		expect(select).toHaveBeenCalledWith(
			"Architect — strong model",
			[
				{ label: "Architect", description: "Strong planning model" },
				{ label: "Fallback", description: "Fallback planning model" },
			],
			1,
		);
	});

	test("treats dismissal as cancellation instead of opening another terminal UI", async () => {
		const picker = createInteractiveNikoflowRolePicker(async () => undefined);

		expect(await picker(request)).toBeNull();
	});
});
