import { describe, test, expect } from 'bun:test';
import { ToolMessage } from '@langchain/core/messages';
import { enforceResultBudget, MAX_TURN_RESULT_CHARS } from './tool-result-budget.js';

// Only the under-budget path is exercised: the over-budget path persists large
// results to disk (via tool-result-storage), which these tests deliberately avoid.

function toolMessage(content: string, id: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: id, name: 'demo' });
}

describe('enforceResultBudget (under budget)', () => {
  test('returns the same array reference when total is within budget', () => {
    const messages = [toolMessage('small', 'a'), toolMessage('also small', 'b')];
    expect(enforceResultBudget(messages)).toBe(messages);
  });

  test('returns an empty array unchanged', () => {
    const messages: ToolMessage[] = [];
    expect(enforceResultBudget(messages)).toBe(messages);
  });

  test('content exactly at the cap is left untouched', () => {
    const messages = [toolMessage('x'.repeat(MAX_TURN_RESULT_CHARS), 'a')];
    expect(enforceResultBudget(messages)).toBe(messages);
  });
});
