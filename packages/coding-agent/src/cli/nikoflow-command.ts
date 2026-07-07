import {
	NIKOFLOW_DEPTHS,
	NIKOFLOW_GRILLING_MODES,
	type NikoflowDepth,
	type NikoflowGrillingMode,
} from "../nikoflow/state";

export type ParsedNikoflowArgs =
	| { depth: NikoflowDepth; autonomous: boolean; grillingMode: NikoflowGrillingMode | null; argv: string[] }
	| { error: string };

const ROLE_FLAGS: Record<string, string> = {
	"--exec": "--model",
	"--architect": "--plan",
	"--qa": "--nikoflow-qa",
};

function parseDepth(value: string | undefined): NikoflowDepth | undefined {
	const normalized = value?.toLowerCase();
	return normalized && NIKOFLOW_DEPTHS.includes(normalized as NikoflowDepth)
		? (normalized as NikoflowDepth)
		: undefined;
}

function parseGrillingMode(value: string | undefined): NikoflowGrillingMode | undefined {
	const normalized = value?.toLowerCase();
	return normalized && NIKOFLOW_GRILLING_MODES.includes(normalized as NikoflowGrillingMode)
		? (normalized as NikoflowGrillingMode)
		: undefined;
}

function flagEnabled(arg: string, flag: string): boolean {
	return arg === flag || arg === `${flag}=true`;
}

export function normalizeNikoflowCommandArgs(argv: string[]): ParsedNikoflowArgs {
	let depth: NikoflowDepth = "standard";
	let autonomous = false;
	let grillingMode: NikoflowGrillingMode | null = null;
	let sawPositional = false;
	const rest: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		const equalsIndex = arg.indexOf("=");
		const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
		const mappedFlag = ROLE_FLAGS[flag];
		if (mappedFlag) {
			const value = equalsIndex === -1 ? argv[index + 1] : arg.slice(equalsIndex + 1);
			if (!value) return { error: `Missing value for ${flag}` };
			rest.push(mappedFlag, value);
			if (equalsIndex === -1) index += 1;
			continue;
		}
		if (!sawPositional) {
			const positionalDepth = parseDepth(arg);
			if (positionalDepth) {
				depth = positionalDepth;
				sawPositional = true;
				continue;
			}
		}
		if (arg === "--depth") {
			const next = argv[index + 1];
			const parsed = parseDepth(next);
			if (!parsed) return { error: `Invalid Nikoflow depth: ${next ?? ""}` };
			depth = parsed;
			sawPositional = true;
			index += 1;
			continue;
		}
		if (arg.startsWith("--depth=")) {
			const parsed = parseDepth(arg.slice("--depth=".length));
			if (!parsed) return { error: `Invalid Nikoflow depth: ${arg.slice("--depth=".length)}` };
			depth = parsed;
			sawPositional = true;
			continue;
		}
		if (arg === "--batch") {
			autonomous = true;
			continue;
		}
		if (flagEnabled(arg, "--interview") || flagEnabled(arg, "--brief")) {
			grillingMode = flagEnabled(arg, "--interview") ? "interview" : "brief";
			rest.push("--nikoflow-grilling", grillingMode);
			continue;
		}
		if (arg === "--nikoflow-grilling") {
			const parsed = parseGrillingMode(argv[index + 1]);
			if (!parsed) return { error: `Invalid Nikoflow grilling mode: ${argv[index + 1] ?? ""}` };
			grillingMode = parsed;
			rest.push("--nikoflow-grilling", parsed);
			index += 1;
			continue;
		}
		if (arg.startsWith("--nikoflow-grilling=")) {
			const parsed = parseGrillingMode(arg.slice("--nikoflow-grilling=".length));
			if (!parsed) return { error: `Invalid Nikoflow grilling mode: ${arg.slice("--nikoflow-grilling=".length)}` };
			grillingMode = parsed;
			rest.push("--nikoflow-grilling", parsed);
			continue;
		}
		sawPositional = true;
		rest.push(arg);
	}

	if (autonomous && grillingMode === "interview") {
		return { error: "Deep interview requires an interactive human; drop --interview or --batch." };
	}

	return { depth, autonomous, grillingMode, argv: rest };
}
