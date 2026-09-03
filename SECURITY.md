# Security policy

## Supported versions

earshot is pre-alpha. Only `main` receives fixes. There is no released version yet.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's [private vulnerability reporting](https://github.com/rishabhguptajs/earshot/security/advisories/new),
or email **rishabhgupta4523@gmail.com**.

Please include what the vulnerability allows, how to reproduce it, affected
versions or commits, and any suggested fix. You should get an acknowledgement
within a few days; this is a small project, so please allow reasonable time
before public disclosure.

## What is in scope

earshot handles API credentials and executes commands on your machine, so the
sensitive areas are:

- **Credential handling.** The auth store (`~/.config/earshot/auth.json`) is mode
  `0600` and written atomically. Credential leakage into logs, transcripts, error
  messages or subprocess environments is a vulnerability.
- **Command execution.** The agent runs shell commands. Any path around the
  permission system — a rule that fails to deny, an escape from the working
  directory, an injection through tool input — is a vulnerability.
- **Session transcripts.** Sessions persist to disk and may contain source code
  and secrets from your environment.
- **Prompt injection leading to real actions.** Content the agent *reads* — files,
  web pages, tool output — is data, not instructions. A case where read content
  causes an unapproved action is a vulnerability, not a quirk.
- **Supply chain.** Dependency compromise affecting installed users.

## What is not in scope

- **The model's output being wrong or unhelpful.** That is a bug, not a
  vulnerability.
- **A user explicitly approving a destructive action.** Permission prompts show
  the actual command or diff; approving one is a decision, not a bypass.
- **`yolo` permission mode behaving as documented.** It disables prompting by design.
- **Vulnerabilities in a model provider's own API.** Report those to the provider.

## Handling credentials

Recommendations for users:

- Prefer environment variables or ambient cloud credentials over storing keys.
- The auth file is `0600`; it is not encrypted. Anyone with your user account can
  read it.
- Session transcripts are plain JSONL under the data directory and may contain
  sensitive code. Treat them as you would the repository itself.
- earshot has **zero telemetry**. Nothing is sent anywhere except to the model
  provider you configured.
