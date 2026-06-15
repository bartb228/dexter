import { describe, test, expect } from 'bun:test';
import { InMemoryChatHistory } from './in-memory-chat-history.js';

// Note: saveAnswer() calls the LLM to summarize, so it is intentionally not
// exercised here. These tests cover the synchronous, side-effect-free surface.

describe('InMemoryChatHistory', () => {
  test('starts with no messages', () => {
    const history = new InMemoryChatHistory();
    expect(history.hasMessages()).toBe(false);
    expect(history.getMessages()).toEqual([]);
  });

  test('saveUserQuery appends a pending turn with an incrementing id', () => {
    const history = new InMemoryChatHistory();
    history.saveUserQuery('first');
    history.saveUserQuery('second');

    const messages = history.getMessages();
    expect(messages.length).toBe(2);
    expect(messages[0]).toEqual({ id: 0, query: 'first', answer: null, summary: null });
    expect(messages[1].id).toBe(1);
    expect(history.hasMessages()).toBe(true);
  });

  test('getMessages returns a copy that does not mutate internal state', () => {
    const history = new InMemoryChatHistory();
    history.saveUserQuery('q');
    const copy = history.getMessages();
    copy.pop();
    expect(history.getMessages().length).toBe(1);
  });

  test('pruneLastTurn removes the most recent turn', () => {
    const history = new InMemoryChatHistory();
    history.saveUserQuery('a');
    history.saveUserQuery('b');
    history.pruneLastTurn();
    expect(history.getMessages().map((m) => m.query)).toEqual(['a']);
  });

  test('pruneLastTurn is a no-op on empty history', () => {
    const history = new InMemoryChatHistory();
    history.pruneLastTurn();
    expect(history.hasMessages()).toBe(false);
  });

  test('clear removes all turns', () => {
    const history = new InMemoryChatHistory();
    history.saveUserQuery('a');
    history.clear();
    expect(history.hasMessages()).toBe(false);
  });

  test('getRecentTurnsAsMessages excludes pending (unanswered) turns', () => {
    const history = new InMemoryChatHistory();
    history.saveUserQuery('a');
    // answer is still null -> not yet a completed turn
    expect(history.getRecentTurnsAsMessages()).toEqual([]);
  });

  test('getRecentTurnsAsMessages returns nothing when the limit is 0', () => {
    const history = new InMemoryChatHistory();
    history.saveUserQuery('a');
    expect(history.getRecentTurnsAsMessages(0)).toEqual([]);
  });
});
