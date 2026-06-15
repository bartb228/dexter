import { describe, test, expect } from 'bun:test';
import { cursorHandlers } from './input-key-handlers.js';

describe('cursorHandlers horizontal movement', () => {
  test('moveLeft decrements but clamps at 0', () => {
    expect(cursorHandlers.moveLeft({ text: 'abc', cursorPosition: 2 })).toBe(1);
    expect(cursorHandlers.moveLeft({ text: 'abc', cursorPosition: 0 })).toBe(0);
  });

  test('moveRight increments but clamps at text length', () => {
    expect(cursorHandlers.moveRight({ text: 'abc', cursorPosition: 1 })).toBe(2);
    expect(cursorHandlers.moveRight({ text: 'abc', cursorPosition: 3 })).toBe(3);
  });

  test('moveToLineStart / moveToLineEnd bound the current line', () => {
    const ctx = { text: 'ab\ncde', cursorPosition: 5 }; // on "cde"
    expect(cursorHandlers.moveToLineStart(ctx)).toBe(3);
    expect(cursorHandlers.moveToLineEnd(ctx)).toBe(6);
  });
});

describe('cursorHandlers vertical movement', () => {
  test('moveUp returns null on the first line', () => {
    expect(cursorHandlers.moveUp({ text: 'ab\ncde', cursorPosition: 1 })).toBeNull();
  });

  test('moveUp keeps the column when moving to the previous line', () => {
    // pos 5 = "e" on line 1, column 2 -> line 0 column 2 = pos 2
    expect(cursorHandlers.moveUp({ text: 'ab\ncde', cursorPosition: 5 })).toBe(2);
  });

  test('moveDown returns null on the last line', () => {
    expect(cursorHandlers.moveDown({ text: 'ab\ncde', cursorPosition: 5 })).toBeNull();
  });

  test('moveDown keeps the column when moving to the next line', () => {
    // pos 1 = "b" on line 0, column 1 -> line 1 column 1 = pos 4
    expect(cursorHandlers.moveDown({ text: 'ab\ncde', cursorPosition: 1 })).toBe(4);
  });
});

describe('cursorHandlers word movement', () => {
  test('moveWordBackward jumps to the previous word start', () => {
    expect(cursorHandlers.moveWordBackward({ text: 'hello world', cursorPosition: 11 })).toBe(6);
  });

  test('moveWordForward jumps to the next word end', () => {
    expect(cursorHandlers.moveWordForward({ text: 'hello world', cursorPosition: 0 })).toBe(5);
  });
});
