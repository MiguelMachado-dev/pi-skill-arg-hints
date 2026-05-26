# pi-skill-arg-hints

Inline `argument-hint` placeholders for [Pi](https://pi.dev) skill and prompt template slash commands.

When you type a command such as:

```text
/skill:handoff
```

or a prompt template command such as:

```text
/review
```

this extension reads the resolved skill/template file, finds its frontmatter `argument-hint`, and displays it inline in a dim placeholder style. The hint is visual only; it is not inserted into the prompt and disappears when you start typing arguments.

## Install

```bash
pi install npm:pi-skill-arg-hints
```

Then restart Pi or run:

```text
/reload
```

## Usage

Add `argument-hint` to a skill:

```md
---
name: handoff
description: Compact the current conversation into a handoff document.
argument-hint: "What will the next session be used for?"
---
```

Typing this:

```text
/skill:handoff
```

will visually show:

```text
/skill:handoff What will the next session be used for?
```

Add `argument-hint` to a prompt template:

```md
---
description: Review a pull request
argument-hint: "<PR-URL>"
---

Review this pull request: $1
```

Typing this:

```text
/review
```

will visually show:

```text
/review <PR-URL>
```

## Behavior

- Supports Pi skills invoked as `/skill:<name>`.
- Supports Pi prompt templates invoked as `/<template-name>`.
- Resolves files through Pi's command registry; no hardcoded skill/template paths.
- Shows the hint only when the command has no arguments yet.
- Leaves the editor buffer unchanged, so placeholders are never submitted.
- Does nothing for commands without `argument-hint`.

## Development

```bash
npm install
npm run check
pi -e .
```

## Publishing

Publishing is handled by the manual GitHub Actions workflow in `.github/workflows/publish-npm.yml`.

Before using it, add an npm automation token as the repository secret `NPM_TOKEN`.
Then open **Actions → Publish to npm → Run workflow**, choose the version bump and npm dist-tag, and run it.
The workflow installs dependencies, typechecks, optionally bumps the package version, publishes to npm, and pushes the release commit/tag.

## License

MIT
