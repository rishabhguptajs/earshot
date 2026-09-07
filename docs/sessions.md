# Chats and transcripts

Earshot stores chats as append-only JSONL transcripts, isolated by working
directory. Plain `earshot` creates a new transcript.

`earshot sessions` and the in-chat `/sessions` command search chats for the current directory. Rows show the
first user prompt, update time, latest model, and short ID. `earshot --continue`
resumes the latest chat; `earshot --resume <path>` opens an exact transcript.

Model and reasoning changes are appended rather than rewriting history. Legacy
transcripts containing only their original metadata remain readable.
