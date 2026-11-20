import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGalleryVerdict, galleryPromptForAgent } from './galleryVision.ts';

test('parseGalleryVerdict: czysty JSON like/dislike', () => {
  assert.deepEqual(parseGalleryVerdict('{"ocena":"like","komentarz":"Świetne ujęcie!"}'), { verdict: 'like', comment: 'Świetne ujęcie!' });
  assert.deepEqual(parseGalleryVerdict('{"ocena":"dislike","komentarz":"Za ciemne."}'), { verdict: 'dislike', comment: 'Za ciemne.' });
});

test('parseGalleryVerdict: JSON w bloku markdown i z tekstem wokół', () => {
  const r = parseGalleryVerdict('Oto moja ocena:\n```json\n{"ocena": "like", "komentarz": "Ładne kolory."}\n```\n');
  assert.equal(r.verdict, 'like');
  assert.equal(r.comment, 'Ładne kolory.');
});

test('parseGalleryVerdict: angielskie pola verdict/comment', () => {
  assert.deepEqual(parseGalleryVerdict('{"verdict":"dislike","comment":"Blurry."}'), { verdict: 'dislike', comment: 'Blurry.' });
});

test('parseGalleryVerdict: brak JSON → heurystyka z treści', () => {
  assert.equal(parseGalleryVerdict('To zdjęcie mi się bardzo podoba, świetna kompozycja.').verdict, 'like');
  assert.equal(parseGalleryVerdict('Niestety słabe, nie podoba mi się oświetlenie.').verdict, 'dislike');
});

test('parseGalleryVerdict: JSON tylko z komentarzem → werdykt z treści', () => {
  const r = parseGalleryVerdict('{"komentarz":"Kiepska ostrość, rozczarowujące."}');
  assert.equal(r.verdict, 'dislike');
  assert.equal(r.comment, 'Kiepska ostrość, rozczarowujące.');
});

test('galleryPromptForAgent: różne persony dla Mayi i Bielika', () => {
  assert.match(galleryPromptForAgent('Maya Mitek'), /Maya Mitek/);
  assert.match(galleryPromptForAgent('Bielik'), /Bielik/);
  assert.match(galleryPromptForAgent('Bielik'), /JSON/);
});
