'use strict';

process.env.STORY_AI = 'off';
const test = require('node:test');
const assert = require('node:assert');
const { generateStory, rollSeed, buildUserPrompt, countCombinations } = require('../server/stories/generator');

test('комбинаций семян больше миллиона', () => {
  assert.ok(countCombinations() > 1_000_000);
});

test('офлайн-история содержит по странице на игрока', async () => {
  for (let n = 1; n <= 8; n++) {
    const story = await generateStory(n);
    assert.strictEqual(story.pages.length, n);
    assert.ok(story.title);
    for (const p of story.pages) {
      assert.ok(p.text.length > 40, p.text);
      assert.ok(p.scene);
      assert.ok(!/undefined|\$\{/.test(p.text + p.scene), p.text);
    }
  }
});

test('семена не повторяются', () => {
  const keys = new Set();
  for (let i = 0; i < 20000; i++) keys.add(rollSeed().key);
  assert.strictEqual(keys.size, 20000);
});

test('промпт включает элементы семени и число страниц', () => {
  const seed = rollSeed();
  const prompt = buildUserPrompt(seed, 5);
  assert.match(prompt, /ровно из 5 страниц/);
  assert.ok(prompt.includes(seed.hero.nom));
  assert.ok(prompt.includes(seed.setting.nom));
});
