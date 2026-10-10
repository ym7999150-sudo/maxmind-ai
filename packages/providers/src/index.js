'use strict';
const { Registry } = require('./registry');
const { detect, hints, validKeyShape } = require('./detect');
const adapters = {
  'openai-compatible': require('./adapters/openai-compatible'),
  anthropic: require('./adapters/anthropic'),
  gemini: require('./adapters/gemini')
};
function getAdapter(def) {
  if (def.adapter === 'mock') return require('./adapters/mock');
  const a = adapters[def.adapter];
  if (!a) throw new Error(`No adapter "${def.adapter}" for provider ${def.id}`);
  return a;
}
module.exports = { Registry, detect, hints, validKeyShape, getAdapter, adapters, ...require('./adapters/common'), sseData: require('./sse').sseData };
