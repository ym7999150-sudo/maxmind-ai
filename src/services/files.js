'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { MaxMindError } = require('@maxmind-ai/core');
const { estimateTokens } = require('@maxmind-ai/token-engine');

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log', 'html', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'sql', 'swift', 'kt']);
const IMG = { png: ['image/png', [0x89, 0x50, 0x4e, 0x47]], jpg: ['image/jpeg', [0xff, 0xd8, 0xff]], jpeg: ['image/jpeg', [0xff, 0xd8, 0xff]], gif: ['image/gif', [0x47, 0x49, 0x46, 0x38]], webp: ['image/webp', null] };

function sniff(name, buf) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (IMG[ext]) { const [mime, magic] = IMG[ext]; const ok = ext === 'webp' ? buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' : magic.every((b, i) => buf[i] === b); return ok ? { kind: 'image', mime, ext } : null; }
  if (ext === 'pdf') return buf.slice(0, 5).toString() === '%PDF-' ? { kind: 'pdf', mime: 'application/pdf', ext } : null;
  if (ext === 'docx') return buf[0] === 0x50 && buf[1] === 0x4b ? { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext } : null;
  if (TEXT_EXT.has(ext)) { const sample = buf.slice(0, 4096); if (sample.includes(0)) return null; return { kind: 'text', mime: 'text/plain', ext }; }
  return null;
}
/** Minimal DOCX text extraction (zip central directory + inflate of word/document.xml, bounded output). */
function docxText(buf) {
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new MaxMindError('BAD_DOCX', 'Not a valid DOCX file.', { status: 400 });
  let off = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString();
    if (name === 'word/document.xml') {
      const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28); const data = buf.slice(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
      const xml = (method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 30 * 1048576 }) : data).toString('utf8');
      return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
    }
    off += 46 + nlen + elen + clen;
  }
  throw new MaxMindError('BAD_DOCX', 'word/document.xml not found.', { status: 400 });
}
async function pdfText(buf) {
  let pdf; try { pdf = require('pdf-parse'); } catch { return { unsupported: true }; }
  const r = await pdf(buf); return { text: String(r.text || '').replace(/\n{3,}/g, '\n\n').trim() };
}

function createFiles({ cfg, db }) {
  const safeName = (n) => String(n || 'file').replace(/[\\/\0]/g, '_').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'file';
  async function extract(buf, info) {
    if (info.kind === 'text') return buf.toString('utf8');
    if (info.kind === 'docx') return docxText(buf);
    if (info.kind === 'pdf') { const r = await pdfText(buf); if (r.unsupported) throw new MaxMindError('PDF_UNSUPPORTED', 'PDF text extraction needs the optional "pdf-parse" package (npm install pdf-parse). Not available, so PDFs are unsupported right now.', { status: 501 }); return r.text; }
    return null;
  }
  async function save(userId, { name, dataBase64, chatId = null }) {
    name = safeName(name);
    if (typeof dataBase64 !== 'string' || !dataBase64) throw new MaxMindError('NO_FILE', 'No file data.', { status: 400 });
    if (dataBase64.length > cfg.maxUploadBytes * 1.4) throw new MaxMindError('TOO_LARGE', `File exceeds ${Math.round(cfg.maxUploadBytes / 1048576)} MB.`, { status: 413 });
    const buf = Buffer.from(dataBase64, 'base64');
    if (!buf.length || buf.length > cfg.maxUploadBytes) throw new MaxMindError('TOO_LARGE', `File must be 1 byte – ${Math.round(cfg.maxUploadBytes / 1048576)} MB.`, { status: 413 });
    const info = sniff(name, buf);
    if (!info) throw new MaxMindError('UNSUPPORTED_TYPE', 'Unsupported or mismatching file type. Allowed: text/code/CSV/JSON, DOCX, PDF, PNG/JPEG/GIF/WebP (content is verified, not just the extension).', { status: 415 });
    let text = null; let tokens = null;
    if (info.kind !== 'image') { text = await extract(buf, info); if (!text || !text.trim()) throw new MaxMindError('EMPTY_TEXT', 'No readable text found in the file.', { status: 422 }); tokens = estimateTokens(text); }
    const id = db.id(); const dir = path.join(cfg.uploadDir, userId); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id); fs.writeFileSync(file, buf, { mode: 0o600 });
    if (text != null) fs.writeFileSync(file + '.txt', text, { mode: 0o600 });
    db.run('INSERT INTO attachments(id,user_id,chat_id,name,mime,kind,size,path,text_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, userId, chatId, name, info.mime, info.kind, buf.length, file, tokens, Date.now());
    return { id, name, kind: info.kind, mime: info.mime, size: buf.length, textTokens: tokens, preview: text ? text.slice(0, 400) : null };
  }
  function load(userId, ids) {
    const out = [];
    for (const id of (ids || []).slice(0, 8)) {
      const a = db.get('SELECT * FROM attachments WHERE id=? AND user_id=?', String(id), userId); if (!a) throw new MaxMindError('NOT_FOUND', 'Attachment not found.', { status: 404 });
      out.push({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size, textTokens: a.text_tokens, text: a.kind === 'image' ? null : fs.readFileSync(a.path + '.txt', 'utf8'), base64: a.kind === 'image' ? fs.readFileSync(a.path).toString('base64') : null });
    }
    return out;
  }
  function content(userId, id) { const a = db.get('SELECT * FROM attachments WHERE id=? AND user_id=?', id, userId); if (!a) throw new MaxMindError('NOT_FOUND', 'Attachment not found.', { status: 404 }); return { name: a.name, mime: a.kind === 'image' ? a.mime : 'application/octet-stream', buf: fs.readFileSync(a.path) }; }
  function saveGeneratedImage(userId, chatId, buf, mime = 'image/png') {
    const id = db.id(); const dir = path.join(cfg.uploadDir, userId); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, id); fs.writeFileSync(file, buf, { mode: 0o600 });
    db.run('INSERT INTO attachments(id,user_id,chat_id,name,mime,kind,size,path,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, userId, chatId, 'generated-image', mime, 'image', buf.length, file, Date.now()); return id;
  }
  return { save, load, content, saveGeneratedImage, sniff, docxText };
}
module.exports = { createFiles, sniff, docxText };
