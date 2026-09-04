/**
 * Spots a correction in what the user just typed.
 *
 * Detection only proposes; nothing is remembered without the user pressing a
 * key. That asymmetry is deliberate - a false positive costs one dismissed
 * suggestion, while a silently stored wrong rule follows them into every future
 * session, and they would have no idea it was there.
 */
export interface MemoryCandidate {
  /** The rule, as it would be stored. */
  text: string;
  /** The sentence it was taken from, kept verbatim as provenance. */
  source: string;
}

/** Phrasings that state a standing preference rather than a one-off instruction. */
const RULES: RegExp[] = [
  /\b(?:always|never)\b[^.!?]*/i,
  /\b(?:don'?t|do not|stop)\s+[^.!?]*/i,
  /\buse\s+[^.!?]*?\b(?:not|instead of|rather than)\b[^.!?]*/i,
  /\b(?:no more|prefer)\s+[^.!?]*/i,
  /\bi (?:already )?told you\b[^.!?]*/i,
];

/**
 * Marks the instruction as being about this task, not about how to work in
 * general. "Don't touch the tests in this PR" is not a preference.
 */
const ONE_OFF =
  /\b(?:this (?:time|once|file|function|test|case|pr|branch)|for now|just here|right now|in this)\b/i;

export function detectPreference(prompt: string): MemoryCandidate | undefined {
  const text = prompt.trim();
  if (text === '' || text.length > 400) return undefined;

  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    const trimmed = sentence.trim();
    if (trimmed === '' || ONE_OFF.test(trimmed)) continue;
    for (const rule of RULES) {
      const match = rule.exec(trimmed);
      if (!match) continue;
      const captured = match[0].trim().replace(/[,;:]$/, '');
      // Two words is a fragment, not a rule worth carrying into every session.
      if (captured.split(/\s+/).length < 3) continue;
      return { text: capitalise(captured), source: trimmed };
    }
  }
  return undefined;
}

function capitalise(text: string): string {
  const cleaned = text.replace(/^i (?:already )?told you (?:to |that )?/i, '');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
