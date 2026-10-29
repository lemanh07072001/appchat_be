const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stageDrafts } = require('./stage-homeproxy-static-matrix.cjs');
const draft = { code: 'test_static', version: 1, definition: { example: true } };
function model(rows = []) {
  const created = [];
  return { created, findOne: filter => ({ lean: () => ({ exec: async () => rows.find(row => row.code === filter.code) }) }),
    create: async row => { created.push(row); rows.push(row); } };
}
test('dry run never creates rows', async () => {
  const versions = model();
  assert.equal((await stageDrafts(versions, [draft], false))[0].outcome, 'would-create');
  assert.equal(versions.created.length, 0);
});
test('apply creates only a draft and is repeatable without overwriting', async () => {
  const versions = model();
  assert.equal((await stageDrafts(versions, [draft], true))[0].outcome, 'created');
  assert.equal((await stageDrafts(versions, [draft], true))[0].outcome, 'exists-unchanged');
  assert.equal(versions.created.length, 1);
  assert.equal(versions.created[0].status, 'draft');
});
test('checks all conflicts before creating any draft', async () => {
  for (const row of [{ ...draft, status: 'published' }, { ...draft, status: 'draft', definition: {} }]) {
    const versions = model([row]);
    await assert.rejects(stageDrafts(versions, [{ ...draft, code: 'new' }, draft], true));
    assert.equal(versions.created.length, 0);
  }
});
