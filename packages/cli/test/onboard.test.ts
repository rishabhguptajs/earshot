import { describe, expect, test } from 'bun:test';
import { modelForOnboardingProvider } from '../src/onboard.ts';

describe('onboarding model selection', () => {
  test('switches the default Anthropic model to its OpenRouter equivalent', () => {
    expect(modelForOnboardingProvider('openrouter', 'anthropic/claude-opus-5')).toBe(
      'openrouter/anthropic/claude-opus-5',
    );
  });
});
