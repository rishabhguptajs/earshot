---
layout: home

hero:
  name: earshot
  text: The coding agent that listens before it acts.
  tagline: A provider-neutral terminal agent with explicit scope, deny-first permissions, steerable turns, and honest verification.
  actions:
    - theme: brand
      text: Install earshot
      link: /getting-started
    - theme: alt
      text: Read the architecture
      link: /architecture

features:
  - title: One agent, many providers
    details: Nineteen built-in providers, 896 catalogued models, and one-line support for most OpenAI-compatible vendors.
  - title: Permission is a boundary
    details: Deny always wins. Mutating tools describe the real command or diff, and files can never grant themselves permission.
  - title: History stays honest
    details: Steering, rewind, compaction, hooks, and subagents preserve an append-only transcript instead of rewriting the past.
  - title: Built for terminals
    details: Interactive Ink UI, versioned headless JSON, npm installation, and standalone binaries across macOS, Linux, and Windows.
---

## Start in one command

```bash
npm install --global @raegent/earshot
earshot doctor
```

Set a provider key, run `earshot models`, then start a session in any repository.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
earshot
```

earshot sends no telemetry. Your prompts go only to the model provider you select.
