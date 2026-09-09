import * as fs from 'node:fs';
import * as path from 'node:path';

import { createStudioLayout } from './studio-example.js';

const output = path.resolve(__dirname, '..', 'examples', 'layouts', 'studio.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(createStudioLayout(), null, 2) + '\n', 'utf8');
console.log(`Example layout saved: ${output}`);
