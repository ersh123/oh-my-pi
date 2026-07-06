import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { Args } from "../cli/args";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveAllowedModels,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { HookSelectorComponent } from "../modes/components/hook-selector";
import type { NikoflowRole } from "./state";

const ROLE_PROMPTS: Record<NikoflowRole, string> = {
	plan: "Architect — strong model that plans, grills, writes tickets (modelRoles.plan)",
	default: "Executor — cheap model that writes code (modelRoles.default)",
	advisor: "Reviewer/QA — strong model that gates + reviews (modelRoles.advisor)",
};

const ROLE_ORDER: readonly NikoflowRole[] = ["plan", "default", "advisor"];

export interface NikoflowRolePickerRuntime {
	interactive: boolean;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
}

export interface NikoflowRolePickerOption {
	model: Model<Api>;
	selector: string;
	label: string;
	description: string;
}

export interface NikoflowRolePickerRequest {
	role: NikoflowRole;
	title: string;
	options: NikoflowRolePickerOption[];
	initialIndex: number;
}

export interface NikoflowRoleSelection {
	model: Model<Api>;
	selector: string;
}

export type NikoflowRoleSelections = Partial<Record<NikoflowRole, NikoflowRoleSelection>>;

export type NikoflowRolePicker = (request: NikoflowRolePickerRequest) => Promise<string | null>;

function roleFlagValue(args: Pick<Args, "model" | "plan" | "nikoflowQa">, role: NikoflowRole): string | undefined {
	if (role === "plan") return args.plan;
	if (role === "default") return args.model;
	return args.nikoflowQa;
}

function missingRoles(args: Pick<Args, "model" | "plan" | "nikoflowQa">): NikoflowRole[] {
	return ROLE_ORDER.filter(role => !roleFlagValue(args, role));
}

export function shouldPromptNikoflowModelRoles(
	args: Pick<Args, "nikoflowDepth" | "nikoflowBatch" | "print" | "mode" | "model" | "plan" | "nikoflowQa">,
	runtime: NikoflowRolePickerRuntime,
): boolean {
	return (
		args.nikoflowDepth !== undefined &&
		args.nikoflowBatch !== true &&
		args.print !== true &&
		args.mode === undefined &&
		runtime.interactive &&
		runtime.stdinIsTTY &&
		runtime.stdoutIsTTY &&
		missingRoles(args).length > 0
	);
}

function formatModelDescription(model: Model<Api>): string {
	const parts = [model.name];
	if (model.reasoning) parts.push("reasoning");
	if (model.contextWindow) parts.push(`${formatNumber(model.contextWindow)} context`);
	const cost = model.cost.input + model.cost.output;
	if (cost > 0) parts.push(`$${cost}/M in+out`);
	return parts.filter(Boolean).join(" | ");
}

function toOptions(models: readonly Model<Api>[]): NikoflowRolePickerOption[] {
	return models.map(model => {
		const selector = formatModelStringWithRouting(model);
		return {
			model,
			selector,
			label: selector,
			description: formatModelDescription(model),
		};
	});
}

function sameModel(left: Model<Api> | undefined, right: Model<Api>): boolean {
	return left?.provider === right.provider && left.id === right.id;
}

function configuredRoleIndex(role: NikoflowRole, settings: Settings, models: readonly Model<Api>[]): number {
	const configured = settings.getModelRole(role);
	if (!configured) return -1;
	const availableModels = [...models];
	const resolved = resolveModelRoleValue(configured, availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	if (!resolved.model) return -1;
	return models.findIndex(model => sameModel(resolved.model, model));
}

function defaultRoleIndex(role: NikoflowRole, settings: Settings, models: readonly Model<Api>[]): number {
	const configured = configuredRoleIndex(role, settings, models);
	if (configured >= 0) return configured;
	if (role === "default") {
		let cheapestIndex = 0;
		let cheapestCost = Number.POSITIVE_INFINITY;
		for (let index = 0; index < models.length; index++) {
			const model = models[index]!;
			const cost = model.cost.input + model.cost.output;
			if (cost < cheapestCost) {
				cheapestCost = cost;
				cheapestIndex = index;
			}
		}
		return cheapestIndex;
	}
	const reasoningIndex = models.findIndex(model => model.reasoning);
	return Math.max(0, reasoningIndex);
}

function selectionBySelector(
	options: readonly NikoflowRolePickerOption[],
	selector: string,
): NikoflowRoleSelection | undefined {
	const option = options.find(candidate => candidate.selector === selector);
	return option ? { model: option.model, selector: option.selector } : undefined;
}

function selectorForValidation(
	args: Pick<Args, "model" | "plan" | "nikoflowQa">,
	settings: Settings,
	selections: NikoflowRoleSelections,
	role: NikoflowRole,
): string | undefined {
	return selections[role]?.selector ?? roleFlagValue(args, role) ?? settings.getModelRole(role);
}

export function validateNikoflowRoleSelections(
	args: Pick<Args, "model" | "plan" | "nikoflowQa">,
	settings: Settings,
	selections: NikoflowRoleSelections,
): void {
	const plan = selectorForValidation(args, settings, selections, "plan");
	const executor = selectorForValidation(args, settings, selections, "default");
	const advisor = selectorForValidation(args, settings, selections, "advisor");
	if (plan && executor && plan === executor) {
		throw new Error("Nikoflow model picker requires Architect to differ from Executor.");
	}
	if (!advisor) {
		throw new Error("Nikoflow model picker requires Reviewer/QA. Pass --qa or configure modelRoles.advisor.");
	}
}

export async function collectNikoflowModelRoleSelections(options: {
	args: Pick<Args, "model" | "plan" | "nikoflowQa">;
	settings: Settings;
	models: readonly Model<Api>[];
	pick: NikoflowRolePicker;
}): Promise<NikoflowRoleSelections> {
	if (options.models.length === 0) {
		throw new Error("No available models for Nikoflow role picker. Configure provider auth or enabledModels.");
	}
	const pickerOptions = toOptions(options.models);
	const selections: NikoflowRoleSelections = {};
	for (const role of missingRoles(options.args)) {
		const selected = await options.pick({
			role,
			title: ROLE_PROMPTS[role],
			options: pickerOptions,
			initialIndex: defaultRoleIndex(role, options.settings, options.models),
		});
		if (!selected) {
			throw new Error(
				"Nikoflow model role selection cancelled. Pass --architect/--exec/--qa or configure modelRoles.",
			);
		}
		const selection = selectionBySelector(pickerOptions, selected);
		if (!selection) {
			throw new Error(`Nikoflow model picker returned unknown model: ${selected}`);
		}
		selections[role] = selection;
	}
	validateNikoflowRoleSelections(options.args, options.settings, selections);
	return selections;
}

export async function selectNikoflowModelRole(request: NikoflowRolePickerRequest): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const ui = new TUI(new ProcessTerminal());
	let done = false;
	const optionByLabel = new Map(request.options.map(option => [option.label, option]));
	const finish = (value: string | null) => {
		if (done) return;
		done = true;
		ui.stop();
		resolve(value);
	};
	const selector = new HookSelectorComponent(
		request.title,
		request.options,
		label => finish(optionByLabel.get(label)?.selector ?? null),
		() => finish(null),
		{
			tui: ui,
			initialIndex: request.initialIndex,
			outline: true,
			maxVisible: 18,
			selectionMarker: "radio",
			markableCount: request.options.length,
			helpText: "up/down navigate  enter select  esc cancel",
		},
	);
	ui.showOverlay(selector, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
	ui.setFocus(selector);
	ui.start();
	return promise;
}

export async function promptNikoflowModelRoles(options: {
	args: Pick<Args, "model" | "plan" | "nikoflowQa">;
	settings: Settings;
	modelRegistry: Pick<ModelRegistry, "getAvailable">;
	pick?: NikoflowRolePicker;
}): Promise<NikoflowRoleSelections> {
	const models = await resolveAllowedModels(
		options.modelRegistry,
		options.settings,
		getModelMatchPreferences(options.settings),
	);
	return collectNikoflowModelRoleSelections({
		args: options.args,
		settings: options.settings,
		models,
		pick: options.pick ?? selectNikoflowModelRole,
	});
}
