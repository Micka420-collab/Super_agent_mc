/**
 * Print the action manifest and the generated skill API documentation.
 *   npm run manifest            -> markdown doc
 *   npm run manifest -- --json  -> JSON manifest
 */
import '../actions/index.js';
import { buildManifest, buildSkillApiDoc } from '../actions/registry.js';

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(buildManifest(), null, 2));
} else {
  console.log(buildSkillApiDoc());
}
