/** Public English diagnostics must retain their intended error classification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyError} from '../src/runtime.mjs';

for (const [message, category] of [
  ['Operation cancelled by the client', 'cancellation_or_inactivity'],
  ['Engine inactive for 120000 ms', 'cancellation_or_inactivity'],
  ['Duplicate identifier: server', 'invalid_model'],
  ['Relationship has a missing endpoint: a -> b', 'invalid_model'],
  ['Official MCP validation rejected: invalid', 'mcp_validation_or_connection'],
  ['Link outside the output directory', 'disallowed_path'],
  ['Engines missing. Run npm run setup.', 'dependency_or_engine']
]) {
  test(`classifies: ${message}`, () => {
    assert.deepEqual(classifyError(Error(message)), {message, category});
  });
}
