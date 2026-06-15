import { describe, test, expect } from 'bun:test';
import { AIMessage } from '@langchain/core/messages';
import { extractTextContent, hasToolCalls } from './ai-message.js';

describe('extractTextContent', () => {
  test('returns string content verbatim', () => {
    expect(extractTextContent(new AIMessage({ content: 'hello' }))).toBe('hello');
  });

  test('joins text blocks and ignores non-text blocks', () => {
    const message = new AIMessage({
      content: [
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: 'http://example.com/x.png' } },
        { type: 'text', text: 'second' },
      ] as never,
    });
    expect(extractTextContent(message)).toBe('first\nsecond');
  });

  test('returns empty string when there is no text content', () => {
    expect(extractTextContent(new AIMessage({ content: [] as never }))).toBe('');
  });
});

describe('hasToolCalls', () => {
  test('is true when tool_calls is a non-empty array', () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [{ name: 'get_prices', args: {}, id: 'call_1' }],
    });
    expect(hasToolCalls(message)).toBe(true);
  });

  test('is false when there are no tool calls', () => {
    expect(hasToolCalls(new AIMessage({ content: 'no tools here' }))).toBe(false);
  });
});
