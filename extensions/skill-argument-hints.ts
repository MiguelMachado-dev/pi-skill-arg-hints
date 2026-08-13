import { promises as fs } from "node:fs";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	truncateToWidth,
	visibleWidth,
	type EditorComponent,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

type InlineHint = {
	readonly commandText: string;
	readonly hint: string;
};

type ParsedSlashCommand = {
	readonly commandName: string;
	readonly hasArguments: boolean;
};

type EditorFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: ConstructorParameters<typeof CustomEditor>[2],
) => EditorComponent;

type HintableEditor = EditorComponent & {
	readonly focused?: boolean;
	getCursor(): { line: number; col: number };
	getPaddingX(): number;
	isShowingAutocomplete(): boolean;
};

const FRONTMATTER_DELIMITER = "---";
const INLINE_HINT_COLOR = "\x1b[90m";
const RESET = "\x1b[0m";

function parseSlashCommand(text: string): ParsedSlashCommand | null {
	if (text.includes("\n")) return null;

	const match = text.match(/^\/([^\s/]+)(?:[ \t]+(.*))?$/);
	if (!match) return null;

	const argumentText = match[2];

	return {
		commandName: match[1]!,
		hasArguments: argumentText !== undefined && argumentText.length > 0,
	};
}

function unquoteYamlScalar(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";

	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return trimmed
			.slice(1, -1)
			.replace(/\\"/g, '"')
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\\\/g, "\\");
	}

	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}

	return trimmed;
}

function parseArgumentHint(markdown: string): string | null {
	const normalized = markdown.replace(/^\uFEFF/, "");
	const lines = normalized.split(/\r?\n/);

	if (lines[0] !== FRONTMATTER_DELIMITER) return null;

	const endIndex = lines.findIndex((line, index) => index > 0 && line === FRONTMATTER_DELIMITER);
	if (endIndex === -1) return null;

	for (let index = 1; index < endIndex; index++) {
		const line = lines[index]!;
		const match = line.match(/^argument-hint:\s*(.*)$/);
		if (!match) continue;

		const rawValue = match[1] ?? "";
		if (rawValue === "|" || rawValue === ">") {
			const blockLines: string[] = [];
			for (let blockIndex = index + 1; blockIndex < endIndex; blockIndex++) {
				const blockLine = lines[blockIndex]!;
				if (blockLine.trim() && !/^\s+/.test(blockLine)) break;
				blockLines.push(blockLine.replace(/^\s{2,}/, ""));
			}

			const joined = rawValue === ">" ? blockLines.join(" ") : blockLines.join("\n");
			const hint = joined.trim();
			return hint.length > 0 ? hint : null;
		}

		const hint = unquoteYamlScalar(rawValue).trim();
		return hint.length > 0 ? hint : null;
	}

	return null;
}

async function readArgumentHint(resourcePath: string): Promise<string | null> {
	const markdown = await fs.readFile(resourcePath, "utf8");
	return parseArgumentHint(markdown);
}

class SkillArgumentHintController {
	private hint: InlineHint | null = null;
	private readonly hintCache = new Map<string, string | null>();
	private refreshVersion = 0;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly tui: TUI,
		private readonly editor: HintableEditor,
	) {}

	refresh(): void {
		void this.refreshHint();
	}

	private async refreshHint(): Promise<void> {
		const version = ++this.refreshVersion;
		const text = this.editor.getText();
		const parsed = parseSlashCommand(text);

		if (!parsed || parsed.hasArguments) {
			this.setHint(null, version);
			return;
		}

		const command = this.pi.getCommands().find((candidate) => {
			const supportsInlineHint = candidate.source === "skill" || candidate.source === "prompt";
			return supportsInlineHint && candidate.name === parsed.commandName;
		});

		if (!command) {
			this.setHint(null, version);
			return;
		}

		const resourcePath = command.sourceInfo.path;
		let hint = this.hintCache.get(resourcePath);

		if (hint === undefined) {
			try {
				hint = await readArgumentHint(resourcePath);
			} catch {
				hint = null;
			}
			this.hintCache.set(resourcePath, hint);
		}

		if (version !== this.refreshVersion || this.editor.getText() !== text) return;

		this.setHint(hint ? { commandText: text, hint } : null, version);
	}

	private setHint(nextHint: InlineHint | null, version: number): void {
		if (version !== this.refreshVersion) return;

		const changed = this.hint?.commandText !== nextHint?.commandText || this.hint?.hint !== nextHint?.hint;
		this.hint = nextHint;

		if (changed) this.tui.requestRender();
	}

	render(lines: string[], width: number): string[] {
		if (!this.hint || this.editor.isShowingAutocomplete()) return lines;

		const text = this.editor.getText();
		if (text !== this.hint.commandText || text.includes("\n")) return lines;

		const cursor = this.editor.getCursor();
		if (cursor.line !== 0 || cursor.col !== text.length) return lines;

		// Editor.render() returns: top border, content line(s), bottom border, optional autocomplete.
		if (lines.length < 3) return lines;

		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.editor.getPaddingX(), maxPadding);
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = " ".repeat(paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const cursorCell = this.editor.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[0m` : " ";
		const placeholder = `${INLINE_HINT_COLOR}${this.hint.hint}${RESET}`;
		const visibleText = `${text} ${this.hint.hint}`;
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(visibleText)));

		lines[1] = truncateToWidth(
			`${leftPadding}${text}${cursorCell}${placeholder}${padding}${rightPadding}`,
			width,
			"",
		);
		return lines;
	}
}

function isHintableEditor(editor: EditorComponent): editor is HintableEditor {
	const candidate = editor as Partial<HintableEditor>;
	return (
		typeof candidate.getCursor === "function" &&
		typeof candidate.getPaddingX === "function" &&
		typeof candidate.isShowingAutocomplete === "function"
	);
}

function addArgumentHints(editor: EditorComponent, pi: ExtensionAPI, tui: TUI): EditorComponent {
	if (!isHintableEditor(editor)) return editor;

	const controller = new SkillArgumentHintController(pi, tui, editor);
	const handleInput = editor.handleInput.bind(editor);
	const setText = editor.setText.bind(editor);
	const render = editor.render.bind(editor);

	editor.handleInput = (data: string) => {
		handleInput(data);
		controller.refresh();
	};
	editor.setText = (text: string) => {
		setText(text);
		controller.refresh();
	};
	editor.render = (width: number) => controller.render(render(width), width);

	return editor;
}

export default function skillArgumentHints(pi: ExtensionAPI) {
	let previousEditorFactory: EditorFactory | undefined;
	let installedEditorFactory: EditorFactory | undefined;

	// Resource discovery runs after every extension's session_start handler, so editors
	// installed during startup can be decorated instead of one extension replacing another.
	pi.on("resources_discover", (_event, ctx) => {
		const isNonInteractiveMode = "mode" in ctx && ctx.mode !== "tui";
		const currentEditorFactory = ctx.ui.getEditorComponent();
		if (
			!ctx.hasUI ||
			isNonInteractiveMode ||
			(installedEditorFactory !== undefined && currentEditorFactory === installedEditorFactory)
		) {
			return;
		}

		const baseFactory = currentEditorFactory;
		const factory: EditorFactory = (tui, theme, keybindings) => {
			const editor = baseFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return addArgumentHints(editor, pi, tui);
		};

		previousEditorFactory = baseFactory;
		installedEditorFactory = factory;
		ctx.ui.setEditorComponent(factory);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.ui.getEditorComponent() === installedEditorFactory) {
			ctx.ui.setEditorComponent(previousEditorFactory);
		}
		previousEditorFactory = undefined;
		installedEditorFactory = undefined;
	});
}
