import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importJsonText, openProjectManagairDatabase } from '../src/db.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node --import tsx scripts/import-json.ts <structured-project.json>');
  process.exit(1);
}

const resolvedInput = path.resolve(inputPath);
const context = openProjectManagairDatabase();
try {
  const result = importJsonText(context.db, readFileSync(resolvedInput, 'utf8'));
  console.log(JSON.stringify({ ok: true, dbPath: context.dbPath, ...result }, null, 2));
} finally {
  context.db.close();
}
