import * as assert from 'assert';
import { resolveQuery } from '../src/configManager';

// ---------------------------------------------------------------------------
// Section 1: resolveQuery – basic {today-Nd} substitution
// ---------------------------------------------------------------------------
suite('configManager – resolveQuery basic substitution', () => {
  test('replaces {today-10d} with a date 10 days ago', () => {
    const result = resolveQuery('closed:>{today-10d}');
    const expected = new Date();
    expected.setDate(expected.getDate() - 10);
    const expectedStr = expected.toISOString().slice(0, 10);
    assert.strictEqual(result, `closed:>${expectedStr}`);
  });

  test('replaces {today-0d} with today\'s date', () => {
    const result = resolveQuery('{today-0d}');
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual(result, today);
  });

  test('produces a date in YYYY-MM-DD format', () => {
    const result = resolveQuery('{today-5d}');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Section 2: resolveQuery – multiple tokens, no tokens, various N values
// ---------------------------------------------------------------------------
suite('configManager – resolveQuery multiple / edge tokens', () => {
  test('replaces multiple {today-Nd} tokens in one string', () => {
    const result = resolveQuery('{today-1d} {today-30d}');
    const d1 = new Date(); d1.setDate(d1.getDate() - 1);
    const d30 = new Date(); d30.setDate(d30.getDate() - 30);
    assert.strictEqual(result, `${d1.toISOString().slice(0, 10)} ${d30.toISOString().slice(0, 10)}`);
  });

  test('leaves string unchanged when no tokens present', () => {
    const input = 'is:issue state:open';
    assert.strictEqual(resolveQuery(input), input);
  });

  test('handles large N values (e.g. {today-365d})', () => {
    const result = resolveQuery('{today-365d}');
    const expected = new Date();
    expected.setDate(expected.getDate() - 365);
    assert.strictEqual(result, expected.toISOString().slice(0, 10));
  });

  test('handles N=1', () => {
    const result = resolveQuery('{today-1d}');
    const expected = new Date();
    expected.setDate(expected.getDate() - 1);
    assert.strictEqual(result, expected.toISOString().slice(0, 10));
  });
});

// ---------------------------------------------------------------------------
// Section 3: resolveQuery – edge cases
// ---------------------------------------------------------------------------
suite('configManager – resolveQuery edge cases', () => {
  test('empty string returns empty string', () => {
    assert.strictEqual(resolveQuery(''), '');
  });

  test('malformed token {today-d} (no number) passes through unchanged', () => {
    const input = '{today-d}';
    assert.strictEqual(resolveQuery(input), input);
  });

  test('partial token {today-10} (no "d") passes through unchanged', () => {
    const input = '{today-10}';
    assert.strictEqual(resolveQuery(input), input);
  });

  test('preserves surrounding text around a token', () => {
    const result = resolveQuery('is:issue closed:>{today-7d} state:closed');
    const expected = new Date();
    expected.setDate(expected.getDate() - 7);
    const dateStr = expected.toISOString().slice(0, 10);
    assert.strictEqual(result, `is:issue closed:>${dateStr} state:closed`);
  });
});
