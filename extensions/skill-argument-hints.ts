import { promises as fs } from "node:fs";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	truncateToWidth,
	visibleWidth,
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

class SkillArgumentHintEditor extends CustomEditor {
	private hint: InlineHint | null = null;
	private readonly hintCache = new Map<string, string | null>();
	private refreshVersion = 0;

	constructor(
		private readonly pi: ExtensionAPI,
		tui: TUI,
		theme: EditorTheme,
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		void this.refreshHint();
	}

	override setText(text: string): void {
		super.setText(text);
		void this.refreshHint();
	}

	private async refreshHint(): Promise<void> {
		const version = ++this.refreshVersion;
		const text = this.getText();
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

		if (version !== this.refreshVersion || this.getText() !== text) return;

		this.setHint(hint ? { commandText: text, hint } : null, version);
	}

	private setHint(nextHint: InlineHint | null, version: number): void {
		if (version !== this.refreshVersion) return;

		const changed = this.hint?.commandText !== nextHint?.commandText || this.hint?.hint !== nextHint?.hint;
		this.hint = nextHint;

		if (changed) this.tui.requestRender();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.hint || this.isShowingAutocomplete()) return lines;

		const text = this.getText();
		if (text !== this.hint.commandText || text.includes("\n")) return lines;

		const cursor = this.getCursor();
		if (cursor.line !== 0 || cursor.col !== text.length) return lines;

		// super.render() returns: top border, content line(s), bottom border, optional autocomplete.
		if (lines.length < 3) return lines;

		const paddingX = this.getPaddingX();
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = " ".repeat(paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const cursorCell = this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[0m` : " ";
		const placeholder = `${INLINE_HINT_COLOR}${this.hint.hint}${RESET}`;
		const visibleText = `${text} ${this.hint.hint}`;
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(visibleText) - (this.focused ? 0 : 0)));

		lines[1] = truncateToWidth(`${leftPadding}${text}${cursorCell}${placeholder}${padding}${rightPadding}`, width, "");
		return lines;
	}
}

export default function skillArgumentHints(pi: ExtensionAPI) {
	let previousEditorFactory: unknown;
	let installedEditorFactory: unknown;

	pi.on("session_start", (_event, ctx) => {
		previousEditorFactory = ctx.ui.getEditorComponent();

		const factory = (
			tui: TUI,
			theme: EditorTheme,
			keybindings: ConstructorParameters<typeof CustomEditor>[2],
		) => new SkillArgumentHintEditor(pi, tui, theme, keybindings);

		installedEditorFactory = factory;
		ctx.ui.setEditorComponent(factory);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.ui.getEditorComponent() === installedEditorFactory) {
			ctx.ui.setEditorComponent(previousEditorFactory as Parameters<typeof ctx.ui.setEditorComponent>[0]);
		}
	});
}
