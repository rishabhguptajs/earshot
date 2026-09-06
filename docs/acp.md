# Editor integration with ACP

`earshot acp` runs an [Agent Client Protocol](https://agentclientprotocol.com/)
server over newline-delimited JSON on stdin and stdout. It uses stable ACP v1;
the draft v2 protocol is deliberately not enabled. What that version promises is
in [Compatibility](compatibility.md).

```bash
earshot acp --model anthropic/claude-opus-5
```

The editor owns the process and the interface. earshot still owns the agent
loop, provider connection, tools, permissions, transcript, scope contract and
cost total. Starting it through an editor does not create a second, less strict
execution path.

## Supported protocol surface

- initialization and ACP v1 capability negotiation
- new persistent sessions and loading a session by its earshot session id
- text, image and resource-link prompts
- streamed assistant text and reasoning
- tool-call start, completion, failure and result updates
- cumulative USD cost and context-window usage updates
- permission requests, including the real command or diff in `rawInput.detail`
- `ask_user` through ACP form elicitation
- cancellation of the model request, tools and pending client requests

Image blocks are passed through the same unified message type used by the wire
adapters and rejected before a provider call if the selected model has no vision
capability. Client-provided MCP server definitions are rejected: configure MCP
servers in earshot settings, where project definitions remain disabled until
explicitly trusted.

## Session loading

The ACP session id is the same id used by earshot's JSONL transcript. Loading a
session verifies that the id belongs to the requested working directory, opens
that transcript for append, and replays its user and assistant text to the
client. It never rewrites prior entries.

## Permissions

ACP is a presentation and transport boundary, not an authority boundary. Deny
rules still win in every mode. A request that reaches the editor contains the
actual permission detail, and the editor can allow once, allow that exact action
for this session, or reject it. ACP clients, resource links, elicitation answers,
and editor configuration cannot grant permissions by being loaded.

## Editor QA

Automated tests exercise both ends of the official TypeScript SDK in process and
spawn the real `earshot acp` stdio command. Physical editor checks remain
separate because a protocol simulation cannot verify an editor's UI.

### Zed

1. Build/install earshot and configure a custom ACP agent whose command is
   `earshot acp --model <provider/model>`.
2. Create a session in a repository and send a prompt that streams prose.
3. Ask it to read a file and verify the tool appears and completes.
4. Ask it to edit a file in `ask` mode. Verify the real diff is visible, reject
   once, retry, then allow once.
5. Trigger `ask_user` and submit an answer.
6. Cancel during model streaming and during a permission prompt.
7. Close and load the session; verify earlier messages reappear and a new turn
   appends to the same transcript.

### JetBrains and Neovim

Use the same seven checks with an ACP-capable plugin/client. Record the editor,
plugin version, OS, earshot version, and any unsupported UI element. Protocol
compatibility is implemented, but neither editor is claimed as physically
verified until this checklist is recorded for it.
