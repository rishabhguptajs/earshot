# earshot

A terminal coding agent that actually listens.

Three things it aims to do that existing terminal agents don't do together:

1. **Every provider.** Anthropic, OpenAI, Google, Bedrock, Vertex, Azure, OpenRouter,
   Groq, Ollama, LM Studio, and anything OpenAI-compatible. Adding a vendor should be
   a config entry, not a refactor.
2. **A real terminal UX, everywhere.** Claude-Code-style inline scrollback that also
   works in Windows Terminal, installed with `npm i -g earshot`.
3. **It listens.** No scope creep, asks before guessing, remembers your preferences,
   and is steerable mid-task.

> Status: pre-alpha. Not yet usable. See [the milestones](#milestones).

## Install

```
npm i -g earshot
```

## Milestones

- **M0 Scaffold** - monorepo, CI, `earshot --version`. *(in progress)*
- **M1 Provider layer** - registry, catalog, auth, adapters, headless streaming chat.
- **M2 Coding agent** - tools, permissions, sessions, Ink TUI.
- **M3 Listening features** - scope contract, steering, compaction, memory.
- **M4 Extensibility** - skills, commands, hooks, MCP, subagents.
- **M5 Ship** - docs, binaries, Windows QA.

## License

MIT
