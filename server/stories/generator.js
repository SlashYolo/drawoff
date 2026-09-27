'use strict';

const seeds = require('./seeds');
const { generateProcedural } = require('./procedural');

const MODEL = process.env.STORY_MODEL || 'claude-opus-5';
const AI_TIMEOUT_MS = Number(process.env.STORY_TIMEOUT_MS || 25000);

let client = null;
function getClient() {
  if (client !== null) return client;
  if (process.env.STORY_AI === 'off') return (client = false);
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    // Ключ берётся из ANTHROPIC_API_KEY (или другого стандартного источника SDK).
    client = new Anthropic({ timeout: AI_TIMEOUT_MS, maxRetries: 1 });
  } catch (err) {
    console.warn('[story] SDK недоступен, будет использован офлайн-генератор:', err.message);
    client = false;
  }
  return client;
}

// Недавно использованные семена, чтобы истории не повторялись.
const recentSeeds = new Set();
const RECENT_LIMIT = 50000;

function rollSeed(rng = Math.random) {
  const pick = (arr) => {
    const i = Math.floor(rng() * arr.length);
    return [i, arr[i]];
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const [hi, hero] = pick(seeds.heroes);
    const [ci, companion] = pick(seeds.companions);
    const [si, setting] = pick(seeds.settings);
    const [gi, goal] = pick(seeds.goals);
    const [ai, antag] = pick(seeds.antagonists);
    const [oi, obstacle] = pick(seeds.obstacles);
    const [, obstacle2] = pick(seeds.obstacles.filter((o) => o !== obstacle));
    const [ii, item] = pick(seeds.items);
    const [ti, twist] = pick(seeds.twists);
    const [wi, time] = pick(seeds.times);
    const [ri, genre] = pick(seeds.genres);
    const [ni, tone] = pick(seeds.tones);
    const [di, narrator] = pick(seeds.narrators);
    const key = [hi, ci, si, gi, ai, oi, ii, ti, wi, ri, ni, di].join('.');
    if (recentSeeds.has(key)) continue;
    recentSeeds.add(key);
    if (recentSeeds.size > RECENT_LIMIT) recentSeeds.delete(recentSeeds.values().next().value);
    return { key, hero, companion, setting, goal, antag, obstacle, obstacle2, item, twist, time, genre, tone, narrator };
  }
  // Практически недостижимо при таком числе комбинаций.
  return rollSeed(Math.random);
}

const SYSTEM_PROMPT = `Ты — средневековый летописец и сказитель. Ты пишешь короткие истории на русском языке для рисовальной игры: каждый игрок рисует иллюстрацию к одной странице истории за 3 минуты.

Требования к истории:
- История цельная: у неё есть завязка, развитие и развязка, страницы идут по порядку и связаны друг с другом.
- Каждая страница — 2–4 предложения (не более 350 символов) и описывает одну яркую, конкретную, легко рисуемую сцену: кто где находится и что делает.
- Сцены разных страниц заметно отличаются друг от друга (место, действие, персонажи), чтобы иллюстрации не повторялись.
- Сеттинг — сказочное средневековье. Никакой жестокости, крови и взрослого контента: история подходит для семейной игры.
- Поле "scene" — короткая (до 90 символов) подсказка художнику: что изобразить на этой странице.
- Название — короткое, в духе старинной летописи или баллады.`;

function buildUserPrompt(seed, n) {
  const g = { m: 'мужской', f: 'женский', p: 'несколько персонажей', n: 'средний' }[seed.hero.g];
  return `Напиши историю ровно из ${n} ${plural(n, 'страницы', 'страниц', 'страниц')}.

Жанр: ${seed.genre}.
Тон: ${seed.tone}.
Манера повествования: ${seed.narrator}.
Главный герой: ${seed.hero.nom} (род: ${g}).
Спутник: ${seed.companion.nom}.
Место действия: ${seed.setting.nom}.
Время: ${seed.time.toLowerCase()}.
Цель героя: ${seed.goal.inf}.
Противник: ${seed.antag.nom}.
Препятствие: ${seed.obstacle.t}.
Волшебный предмет: ${seed.item.nom}.
Возможный поворот сюжета: ${seed.twist}

Используй эти элементы свободно и творчески: можно менять детали, если так история станет интереснее, но главный герой, место и цель должны остаться узнаваемыми.${n === 1 ? ' Вся история умещается на одной странице.' : ''}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const STORY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          scene: { type: 'string' },
        },
        required: ['text', 'scene'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'pages'],
  additionalProperties: false,
};

function clean(str, max) {
  return String(str || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function generateWithAI(seed, n) {
  const anthropic = getClient();
  if (!anthropic) return null;

  const request = anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    // Если классификаторы безопасности отклонят запрос, сервер сам повторит его на запасной модели.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Короткий творческий текст: глубокое размышление не нужно, важна скорость.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: STORY_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(seed, n) }],
  });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('таймаут генерации')), AI_TIMEOUT_MS + 2000);
  });
  let response;
  try {
    response = await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }

  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    throw new Error(`модель не завершила историю (${response.stop_reason})`);
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  const pages = (Array.isArray(data.pages) ? data.pages : [])
    .map((p) => ({ text: clean(p.text, 600), scene: clean(p.scene, 140) }))
    .filter((p) => p.text);
  if (pages.length < n) throw new Error(`получено ${pages.length} страниц вместо ${n}`);
  return { title: clean(data.title, 120) || 'Безымянная летопись', pages: pages.slice(0, n), source: 'ai' };
}

/**
 * Генерирует историю из n страниц (по одной на игрока).
 * Сначала пытается спросить нейросеть, при любой ошибке — офлайн-генератор.
 */
async function generateStory(n) {
  const seed = rollSeed();
  try {
    const story = await generateWithAI(seed, n);
    if (story) return { ...story, seed: seed.key };
  } catch (err) {
    console.warn('[story] Нейросеть не ответила, используем офлайн-генератор:', err.message);
  }
  return { ...generateProcedural(seed, n), seed: seed.key };
}

module.exports = { generateStory, rollSeed, buildUserPrompt, countCombinations: seeds.countCombinations };
