import fs from 'fs';
let s = fs.readFileSync('/tmp/v4-log-analysis/analyze.mjs', 'utf8');
s = s.replace("import { createReadStream } from 'fs';", "import { createReadStream, writeFileSync } from 'fs';");
s = s.replace("import { PassThrough } from 'stream';\n", "");
s = s.replace("  const { writeFileSync } = await import('fs');\n", "");
fs.writeFileSync('/tmp/v4-log-analysis/analyze.mjs', s, 'utf8');
console.log('patched');
