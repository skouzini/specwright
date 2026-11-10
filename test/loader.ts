import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { SchemaIndex } from '../src/core/schema';
import { VENDOR } from '../src/core/vendor';

const dir = __dirname + '/../schemas/';
export const loader = (uri: string) => (VENDOR[uri] ? JSON.parse(readFileSync(dir + 'vendor/' + VENDOR[uri], 'utf8')) : undefined);
export const loadIndex = (file: string) => new SchemaIndex(parse(readFileSync(dir + file, 'utf8')), loader);
