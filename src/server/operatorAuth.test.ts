import test from 'node:test';
import assert from 'node:assert/strict';
import { hasOperatorAuthorization, isOperatorTokenRequired } from './operatorAuth.ts';

const VALID_SECRET = 'svl_operator_secret_token_32_characters_minimum_valid';

test('operatorAuth: domyślnie bez SVL_REQUIRE_OPERATOR_TOKEN podgląd i panel są odblokowane bez tokenu', () => {
  const env = { SVL_OPERATOR_TOKEN: VALID_SECRET } as NodeJS.ProcessEnv;
  assert.equal(isOperatorTokenRequired(env), false);
  assert.equal(hasOperatorAuthorization(undefined, env), true);
  assert.equal(hasOperatorAuthorization('', env), true);
  assert.equal(hasOperatorAuthorization(VALID_SECRET, env), true);
  assert.equal(hasOperatorAuthorization('invalid-token-attempt', env), false);
});

test('operatorAuth: SVL_REQUIRE_OPERATOR_TOKEN=0 lub false nie wymaga tokenu w podglądzie', () => {
  const envZero = { SVL_OPERATOR_TOKEN: VALID_SECRET, SVL_REQUIRE_OPERATOR_TOKEN: '0' } as NodeJS.ProcessEnv;
  const envFalse = { SVL_OPERATOR_TOKEN: VALID_SECRET, SVL_REQUIRE_OPERATOR_TOKEN: 'false' } as NodeJS.ProcessEnv;
  assert.equal(isOperatorTokenRequired(envZero), false);
  assert.equal(isOperatorTokenRequired(envFalse), false);
  assert.equal(hasOperatorAuthorization('', envZero), true);
  assert.equal(hasOperatorAuthorization('', envFalse), true);
});

test('operatorAuth: SVL_REQUIRE_OPERATOR_TOKEN=1 bezwzględnie wymaga prawidłowego tokenu >= 32 znaki', () => {
  const env = { SVL_OPERATOR_TOKEN: VALID_SECRET, SVL_REQUIRE_OPERATOR_TOKEN: '1' } as NodeJS.ProcessEnv;
  assert.equal(isOperatorTokenRequired(env), true);
  assert.equal(hasOperatorAuthorization(undefined, env), false);
  assert.equal(hasOperatorAuthorization('', env), false);
  assert.equal(hasOperatorAuthorization('too_short', env), false);
  assert.equal(hasOperatorAuthorization('x'.repeat(VALID_SECRET.length), env), false);
  assert.equal(hasOperatorAuthorization([VALID_SECRET], env), true);
  assert.equal(hasOperatorAuthorization(`  ${VALID_SECRET}  `, env), true);
});
