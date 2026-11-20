import assert from 'node:assert/strict';
import test from 'node:test';
import { hasOperatorAuthorization, isOperatorTokenRequired, operatorTokenMatches } from './operatorAuth.ts';

const SECRET = 'x'.repeat(40);

test('token operatora domyślnie nie jest wymagany', () => {
  assert.equal(isOperatorTokenRequired({}), false);
  assert.equal(hasOperatorAuthorization(undefined, { SVL_OPERATOR_TOKEN: SECRET }), true);
  assert.equal(hasOperatorAuthorization('', { SVL_OPERATOR_TOKEN: SECRET }), true);
});

test('SVL_REQUIRE_OPERATOR_TOKEN=1 przywraca wymóg tokenu', () => {
  const env = { SVL_OPERATOR_TOKEN: SECRET, SVL_REQUIRE_OPERATOR_TOKEN: '1' };
  assert.equal(isOperatorTokenRequired(env), true);
  assert.equal(hasOperatorAuthorization('', env), false);
  assert.equal(hasOperatorAuthorization('y'.repeat(40), env), false);
  assert.equal(hasOperatorAuthorization(SECRET, env), true);
  assert.equal(isOperatorTokenRequired({ SVL_REQUIRE_OPERATOR_TOKEN: '0' }), false);
});

test('operatorTokenMatches porównuje z sekretem niezależnie od trybu', () => {
  assert.equal(operatorTokenMatches(SECRET, { SVL_OPERATOR_TOKEN: SECRET }), true);
  assert.equal(operatorTokenMatches('short', { SVL_OPERATOR_TOKEN: SECRET }), false);
  assert.equal(operatorTokenMatches(SECRET, {}), false);
});
