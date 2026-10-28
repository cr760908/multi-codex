import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnvironment } from '../../src/runtime/EnvBuilder';
test('environment allowlist removes credentials, routing and unknown keys case insensitively',()=>{
  const parent={Path:'C:\\Windows',SystemRoot:'C:\\Windows',CODEX_HOME:'foreign',OPENAI_API_KEY:'secret',openai_base_url:'https://bad.invalid',CODEX_INTERNAL_ORIGINATOR_OVERRIDE:'foreign',UNREVIEWED_SETTING:'value'};
  const built=buildEnvironment(parent,'C:\\owned\\A');
  assert.deepEqual(built.env,{PATH:'C:\\Windows',SYSTEMROOT:'C:\\Windows',CODEX_HOME:'C:\\owned\\A'});
  assert.ok(built.policy.every(p=>Object.keys(p).sort().join(',')==='action,key'));
  assert.ok(!JSON.stringify(built.policy).includes('secret'));
});
