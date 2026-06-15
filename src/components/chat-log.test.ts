import { describe, test, expect, afterEach } from 'bun:test';
import { ChatLogComponent } from './chat-log.js';
import { isSpinnerActive } from '../utils/spinner.js';

// Regression for the "CLI gets buggy after some use" bug. Every active tool subscribes to
// the shared 50ms spinner clock and must unsubscribe when its turn ends; a missed
// unsubscribe pins that clock on forever (requestRender at 20fps → cumulative input lag
// that never recovers). The invariant under test: once a turn ends, isSpinnerActive()
// is false — no spinner outlives the turn, even if a tool's terminal event was missed.
describe('ChatLogComponent spinner lifecycle', () => {
  // ChatLogComponent only stores the TUI ref; the spinner is a module singleton, and
  // with no initSpinner() its requestRender() is a no-op, so a stub is safe.
  const stubTui = {} as unknown as ConstructorParameters<typeof ChatLogComponent>[0];

  // The spinner clock is global state — never let a test leak it into the next.
  afterEach(() => {
    expect(isSpinnerActive()).toBe(false);
  });

  test('a tool spinner stops when the tool completes normally', () => {
    const log = new ChatLogComponent(stubTui);
    log.startTool('t1', 'get_stock_price', { ticker: 'AAPL' }); // setActive → subscribes
    expect(isSpinnerActive()).toBe(true);
    log.completeTool('t1', 'AAPL $295', 120); // setComplete → unsubscribes
    expect(isSpinnerActive()).toBe(false);
  });

  test('disposeActiveTools() stops a tool whose terminal event was missed (the leak)', () => {
    const log = new ChatLogComponent(stubTui);
    log.startTool('t1', 'get_financials', { query: 'AAPL revenue' });
    expect(isSpinnerActive()).toBe(true);
    // Simulate the bug's trigger: the turn ends WITHOUT completeTool/errorTool ever firing.
    // The turn-end sweep must still drain the leaked subscription.
    log.disposeActiveTools();
    expect(isSpinnerActive()).toBe(false);
  });

  test('disposeActiveTools() stops a leaked subagent group spinner', () => {
    const log = new ChatLogComponent(stubTui);
    log.startTool('s1', 'spawn_subagent', { description: 'research X', subagent_type: 'general-purpose' });
    expect(isSpinnerActive()).toBe(true);
    // Group is left active (no per-line completion) — the group's own dispose() is the backstop.
    log.disposeActiveTools();
    expect(isSpinnerActive()).toBe(false);
  });

  test('a second-turn subagent gets a fresh, animated group after the first turn ended', () => {
    const log = new ChatLogComponent(stubTui);
    // Turn 1: spawn a subagent, then the turn completes (sweeps spinners + drops group ref).
    log.startTool('s1', 'spawn_subagent', { description: 'turn 1 work' });
    expect(isSpinnerActive()).toBe(true);
    log.disposeActiveTools();
    expect(isSpinnerActive()).toBe(false);
    // Turn 2: a new subagent must NOT reuse the disposed group (which can never animate
    // again) — it must build a fresh group whose spinner subscribes and ticks.
    log.startTool('s2', 'spawn_subagent', { description: 'turn 2 work' });
    expect(isSpinnerActive()).toBe(true);
    log.disposeActiveTools(); // clean up so afterEach sees a drained clock
    expect(isSpinnerActive()).toBe(false);
  });

  test('clearAll() drains spinners too', () => {
    const log = new ChatLogComponent(stubTui);
    log.startTool('t1', 'web_search', { query: 'spacex ipo' });
    log.startTool('s1', 'spawn_subagent', { description: 'dig deeper' });
    expect(isSpinnerActive()).toBe(true);
    log.clearAll();
    expect(isSpinnerActive()).toBe(false);
  });
});
