import { describe, test, expect } from 'bun:test';
import { createProgressChannel } from './progress-channel.js';

describe('createProgressChannel', () => {
  test('delivers buffered messages in order, then terminates on close', async () => {
    const channel = createProgressChannel();
    channel.emit('one');
    channel.emit('two');
    channel.close();

    const received: string[] = [];
    for await (const message of channel) {
      received.push(message);
    }
    expect(received).toEqual(['one', 'two']);
  });

  test('a waiting consumer receives a message emitted later', async () => {
    const channel = createProgressChannel();
    const iterator = channel[Symbol.asyncIterator]();

    const pending = iterator.next(); // consumer waits, nothing buffered
    channel.emit('live');

    const result = await pending;
    expect(result).toEqual({ value: 'live', done: false });
  });

  test('close while a consumer is waiting signals done', async () => {
    const channel = createProgressChannel();
    const iterator = channel[Symbol.asyncIterator]();

    const pending = iterator.next();
    channel.close();

    const result = await pending;
    expect(result.done).toBe(true);
  });

  test('emit after close is ignored', async () => {
    const channel = createProgressChannel();
    channel.close();
    channel.emit('too late');

    const iterator = channel[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined as never, done: true });
  });
});
