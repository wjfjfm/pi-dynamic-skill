// Keep resource-discovery tests away from real user configuration.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'dynamic-skill-tests-'));
process.env.PI_CODING_AGENT_DIR = join(directory, 'agent');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
