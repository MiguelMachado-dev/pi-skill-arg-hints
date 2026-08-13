import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: skillArgumentHints } = await jiti.import(
	join(import.meta.dirname, "../extensions/skill-argument-hints.ts"),
);

class LaterCustomEditor {
	text = "";
	focused = false;
	inputs = [];
	customBehavior = "preserved";

	getText() {
		return this.text;
	}

	setText(text) {
		this.text = text;
		this.onChange?.(text);
	}

	handleInput(data) {
		this.inputs.push(data);
	}

	getCursor() {
		return { line: 0, col: this.text.length };
	}

	getPaddingX() {
		return 0;
	}

	isShowingAutocomplete() {
		return false;
	}

	render(width) {
		return ["─".repeat(width), this.text.padEnd(width), "─".repeat(width)];
	}

	invalidate() {}
}

function createHarness(skillPath) {
	const handlers = new Map();
	let editorFactory;

	const pi = {
		on(event, handler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		getCommands() {
			return [
				{
					name: "skill:handoff",
					source: "skill",
					sourceInfo: { path: skillPath },
				},
			];
		},
	};

	const ui = {
		getEditorComponent() {
			return editorFactory;
		},
		setEditorComponent(factory) {
			editorFactory = factory;
		},
	};

	const ctx = { mode: "tui", hasUI: true, ui };

	return {
		pi,
		ctx,
		getEditorFactory: () => editorFactory,
		setEditorFactory: (factory) => {
			editorFactory = factory;
		},
		async emit(event, payload = {}) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

async function waitForRender(trigger) {
	let timeout;
	try {
		await Promise.race([
			trigger,
			new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new Error("hint render timed out")), 1000);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

test("installs its own editor when no custom editor is configured", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-skill-arg-hints-"));
	const skillPath = join(directory, "SKILL.md");
	await writeFile(
		skillPath,
		'---\nname: handoff\nargument-hint: "What will the next session be used for?"\n---\n',
	);

	try {
		const harness = createHarness(skillPath);
		skillArgumentHints(harness.pi);

		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("resources_discover", { reason: "startup" });

		assert.equal(typeof harness.getEditorFactory(), "function");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("composes with a custom editor registered later during session startup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-skill-arg-hints-"));
	const skillPath = join(directory, "SKILL.md");
	await writeFile(
		skillPath,
		'---\nname: handoff\nargument-hint: "What will the next session be used for?"\n---\n',
	);

	try {
		const harness = createHarness(skillPath);
		skillArgumentHints(harness.pi);

		await harness.emit("session_start", { reason: "startup" });

		const laterEditor = new LaterCustomEditor();
		const laterFactory = () => laterEditor;
		harness.setEditorFactory(laterFactory);

		await harness.emit("resources_discover", { reason: "startup" });

		const composedFactory = harness.getEditorFactory();
		assert.notStrictEqual(
			composedFactory,
			laterFactory,
			"the later editor factory should be decorated rather than left unmodified",
		);

		let hintRendered;
		const hintRender = new Promise((resolve) => {
			hintRendered = resolve;
		});
		const tui = {
			terminal: { rows: 24 },
			requestRender: () => hintRendered(),
		};
		const editor = composedFactory(tui, {}, {});

		assert.strictEqual(editor, laterEditor);
		assert.equal(editor.customBehavior, "preserved");

		editor.setText("/skill:handoff");
		await waitForRender(hintRender);

		assert.match(editor.render(100)[1], /What will the next session be used for\?/);

		editor.handleInput("x");
		assert.deepEqual(laterEditor.inputs, ["x"]);

		await harness.emit("session_shutdown", { reason: "quit" });
		assert.strictEqual(harness.getEditorFactory(), laterFactory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
