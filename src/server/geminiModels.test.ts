import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGeminiError, isGeminiModelGoneError, rankGeminiChatModels } from './geminiModels.ts';

test('rankGeminiChatModels keeps only chat models and prefers fast, stable, newer ones', () => {
  const ranked = rankGeminiChatModels([
    { name: 'models/gemini-2.0-pro', supportedActions: ['generateContent'] },
    { name: 'models/gemini-3-flash-preview', supportedActions: ['generateContent'] },
    { name: 'models/gemini-3.5-flash', supportedActions: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
    { name: 'models/gemini-3.5-flash-image', supportedActions: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedActions: ['embedContent'] },
    { name: 'models/gemini-flash-latest', supportedActions: ['generateContent'] },
  ]);
  assert.deepEqual(ranked, [
    'gemini-flash-latest',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.5-flash-lite',
    'gemini-2.0-pro',
  ]);
});

test('Gemini errors from the screenshot are recognised and described readably', () => {
  const notFound = '{"error":{"code":404,"message":"models/gemini-3-flash-preview is not found for API version v1, or is not supported for generateContent","status":"NOT_FOUND"}}';
  const retired = '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code"}}';
  assert.equal(isGeminiModelGoneError(notFound), true);
  assert.equal(isGeminiModelGoneError(retired), true);
  assert.equal(isGeminiModelGoneError('This operation was aborted'), false);
  assert.match(describeGeminiError(retired), /^404: This model models\/gemini-2\.5-flash is no longer available/);
  assert.equal(describeGeminiError('This operation was aborted', 30000), 'przekroczono limit czasu (30 s)');
});
