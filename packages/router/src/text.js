'use strict';
/** Unicode-aware tokenization (English + Arabic). Arabic diacritics/alef variants are normalized. */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}
function tokens(s) { return norm(s).split(/[^\p{L}\p{N}_#+.]+/u).map((t) => t.replace(/^[.+#]+|[.+#]+$/g, '')).filter((t) => t.length > 1); }
module.exports = { norm, tokens };
