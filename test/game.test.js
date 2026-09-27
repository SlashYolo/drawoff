'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assignPages, sanitizeName } = require('../server/game');

test('каждый игрок получает ровно одну страницу, страницы не повторяются', () => {
  for (let round = 0; round < 500; round++) {
    const n = 1 + (round % 8);
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const choices = {};
    for (const id of ids) if (Math.random() < 0.7) choices[id] = Math.floor(Math.random() * n);
    const { assignments } = assignPages(ids, n, choices);
    assert.strictEqual(Object.keys(assignments).length, n);
    assert.strictEqual(new Set(Object.values(assignments)).size, n);
  }
});

test('спорная страница разыгрывается, проигравший получает оставшуюся', () => {
  // оба хотят страницу 0; «монетка» выбирает второго
  const { assignments, lots } = assignPages(['a', 'b'], 2, { a: 0, b: 0 }, (n) => n - 1);
  assert.deepStrictEqual(assignments, { b: 0, a: 1 });
  assert.strictEqual(lots.length, 1);
  assert.strictEqual(lots[0].winner, 'b');
  assert.deepStrictEqual(lots[0].consolation, { a: 1 });
});

test('бесспорный выбор уважается', () => {
  const { assignments, lots } = assignPages(['a', 'b', 'c'], 3, { a: 2, b: 0 });
  assert.strictEqual(assignments.a, 2);
  assert.strictEqual(assignments.b, 0);
  assert.strictEqual(assignments.c, 1);
  assert.strictEqual(lots.length, 0);
});

test('имя очищается от разметки и обрезается', () => {
  assert.strictEqual(sanitizeName('  <b>Сэр</b>   Ланцелот  '), 'bСэр/b Ланцелот');
  assert.strictEqual(sanitizeName('x'.repeat(50)).length, 20);
});
