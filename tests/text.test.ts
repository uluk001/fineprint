import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, groundQuote, dedupeFindings, redactPII, riskScore, buildFlaggedExcerpts } from '../src/core/text.ts';
import { parseCategories, DEFAULT_CATEGORIES } from '../src/core/categories.ts';
import { SAMPLES } from '../src/core/samples.ts';
import type { Finding } from '../src/core/types.ts';

const f = (over: Partial<Finding>): Finding => ({
  id: 'x', quote: 'q', category: 'auto_renewal', severity: 'low', explanation: 'e', chunkIndex: 0, source: 'on_device', ...over,
});

test('chunkText keeps every chunk under the limit and loses no words', () => {
  for (const s of SAMPLES) {
    const chunks = chunkText(s.text, 1200);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 1200, `chunk too long: ${c.length}`);
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    assert.equal(chunks.reduce((n, c) => n + words(c), 0), words(s.text));
  }
});

test('chunkText splits a giant paragraph by sentences', () => {
  const para = 'This is a sentence about fees. '.repeat(400);
  const chunks = chunkText(para, 500);
  assert.ok(chunks.every((c) => c.length <= 500));
});

test('groundQuote accepts exact quotes with different whitespace and smart quotes', () => {
  const chunk = 'We may change the premium,\n the excess and these terms at renewal. We will tell you.';
  const q = groundQuote('We may change the premium, the excess and these terms at renewal.', chunk);
  assert.equal(q, 'We may change the premium,\n the excess and these terms at renewal');
  const smart = groundQuote('You’ll pay the first $1,500 of every claim for loss', "You'll pay the first $1,500 of every claim for loss or damage");
  assert.ok(smart);
});

test('groundQuote rejects paraphrases (hallucination guard)', () => {
  const chunk = 'You must pay the first $1,500 of every claim for loss or damage to your vehicle.';
  assert.equal(groundQuote('The customer always pays fifteen hundred dollars before any payout happens', chunk), null);
  assert.equal(groundQuote('short', chunk), null);
});

test('groundQuote falls back to a long prefix when the model drifts at the end', () => {
  const chunk = 'Unless you tell us at least thirty (30) days before the renewal date that you do not wish to continue, this policy will renew automatically.';
  const q = groundQuote('Unless you tell us at least thirty (30) days before the renewal date that you do not want it, it renews', chunk);
  assert.ok(q && chunk.includes(q));
});

test('dedupeFindings merges overlapping quotes and keeps the higher severity', () => {
  const out = dedupeFindings([
    f({ quote: 'this policy will renew automatically for a further twelve months', severity: 'low' }),
    f({ quote: 'this policy will renew automatically for a further twelve months and the renewal premium', severity: 'high' }),
    f({ quote: 'We may cancel this policy at any time by giving you 7 days notice', severity: 'medium' }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].severity, 'high');
});

test('riskScore grows with severity and saturates below 100', () => {
  assert.equal(riskScore([]), 0);
  const many = Array.from({ length: 40 }, () => f({ severity: 'high' }));
  assert.ok(riskScore(many) <= 100);
  assert.ok(riskScore([f({ severity: 'high' })]) > riskScore([f({ severity: 'low' })]));
});

test('redactPII removes emails, phones, cards and references', () => {
  const r = redactPII('Mail claims@northpeak-mutual.example or call +1 415 555 0142. Card 4111 1111 1111 1111. Policy number: NP-CAR-2026-448120.');
  assert.ok(!r.text.includes('northpeak-mutual.example'));
  assert.ok(!r.text.includes('4111'));
  assert.ok(!r.text.includes('448120'));
  assert.ok(r.text.includes('[EMAIL]'));
  assert.ok(r.count >= 4);
});

test('buildFlaggedExcerpts shares only context around findings', () => {
  const text = SAMPLES[0].text;
  const quote = 'We may cancel this policy at any time by giving you 7 days';
  const out = buildFlaggedExcerpts(text, [f({ quote, category: 'unilateral_change', severity: 'high' })], 100);
  assert.ok(out.includes(quote));
  assert.ok(out.length < 400);
});

test('parseCategories falls back to defaults on bad Remote Config values', () => {
  assert.equal(parseCategories('not json'), DEFAULT_CATEGORIES);
  assert.equal(parseCategories('[]'), DEFAULT_CATEGORIES);
  const custom = JSON.stringify([
    { id: 'a', label: 'A', hint: 'a' }, { id: 'b', label: 'B', hint: 'b' }, { id: 'c', label: 'C', hint: 'c' },
  ]);
  assert.equal(parseCategories(custom).length, 3);
});
