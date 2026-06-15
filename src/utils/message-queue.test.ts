import { describe, test, expect } from 'bun:test';
import { createMessageQueue, type QueuedMessage } from './message-queue.js';

function msg(text: string, priority: 'next' | 'later', enqueuedAt = 0): QueuedMessage {
  return { text, priority, enqueuedAt };
}

describe('createMessageQueue', () => {
  test('starts empty', () => {
    const q = createMessageQueue();
    expect(q.isEmpty()).toBe(true);
    expect(q.length()).toBe(0);
    expect(q.dequeue()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
  });

  test('dequeue returns higher-priority "next" before "later"', () => {
    const q = createMessageQueue();
    q.enqueue(msg('later-one', 'later', 1));
    q.enqueue(msg('next-one', 'next', 2));
    expect(q.dequeue()?.text).toBe('next-one');
    expect(q.dequeue()?.text).toBe('later-one');
    expect(q.isEmpty()).toBe(true);
  });

  test('peek returns the next item without removing it', () => {
    const q = createMessageQueue();
    q.enqueue(msg('a', 'next', 1));
    expect(q.peek()?.text).toBe('a');
    expect(q.length()).toBe(1);
  });

  test('dequeueAll drains by priority then enqueue time', () => {
    const q = createMessageQueue();
    q.enqueue(msg('later-early', 'later', 1));
    q.enqueue(msg('next-late', 'next', 5));
    q.enqueue(msg('next-early', 'next', 2));
    const drained = q.dequeueAll().map((m) => m.text);
    expect(drained).toEqual(['next-early', 'next-late', 'later-early']);
    expect(q.isEmpty()).toBe(true);
  });

  test('snapshot is frozen and reflects the latest contents', () => {
    const q = createMessageQueue();
    q.enqueue(msg('a', 'next', 1));
    const snap = q.snapshot();
    expect(snap.length).toBe(1);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  test('subscribers are notified on change and can unsubscribe', () => {
    const q = createMessageQueue();
    let calls = 0;
    const unsubscribe = q.subscribe(() => { calls++; });
    q.enqueue(msg('a', 'next', 1)); // notify
    q.clear();                      // notify
    expect(calls).toBe(2);
    unsubscribe();
    q.enqueue(msg('b', 'next', 1)); // no longer observed
    expect(calls).toBe(2);
  });

  test('instances are independent', () => {
    const a = createMessageQueue();
    const b = createMessageQueue();
    a.enqueue(msg('x', 'next', 1));
    expect(a.length()).toBe(1);
    expect(b.length()).toBe(0);
  });
});
