'use strict';
/** Minimal Server-Sent-Events parser over a fetch Response body. Yields the `data:` payload strings. */
async function* sseData(resp) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of resp.body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
  const tail = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
  if (tail) yield tail;
}
module.exports = { sseData };
