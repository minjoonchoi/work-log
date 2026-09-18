import Ajv from 'ajv';
import { assert, digest, json } from './shared.mjs';

const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const cache = new Map();
export function canonicalJson(value) {
  const order = item => Array.isArray(item) ? item.map(order) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])])) : item;
  return JSON.stringify(order(value));
}
export function compileSchema(schema) {
  const key = digest(json(schema));
  if (!cache.has(key)) cache.set(key, ajv.compile(schema));
  return cache.get(key);
}
export function validateSchema(schema, value, label = '계약') {
  const validate = compileSchema(schema);
  assert(validate(value), `${label} 위반: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
  return value;
}
