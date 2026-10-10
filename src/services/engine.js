'use strict';
const crypto = require('crypto');
const { MaxMindError, HEALTH, ProviderError } = require('@maxmind-ai/core');
const { getAdapter } = require('@maxmind-ai/providers');
const { analyzeTask, scoreCandidates, buildPlan } = require('@maxmind-ai/router');
const TE = require('@maxmind-ai/token-engine');
const { getSettings } = require('./settings');
const { audit } = require('./audit');

const SYSTEM_BASE = 'You are MAXMIND AI, a precise and helpful assistant. Reply in the same language the user writes in. Be concise unless asked for detail. Use Markdown; put code in fenced blocks.';
const ROLE_HINT = { coder: 'Focus on correct, runnable code and note edge cases.', analyst: 'Reason in a structured way and state conclusions clearly.', researcher: 'Be factual; say when you are unsure.', writer: 'Focus on clear, well-styled prose.', vision: 'Describe and interpret the image(s) carefully.', specialist: 'Contribute your strongest, most distinctive analysis.', primary: '', generalist: '' };
const REVIEW_SYSTEM = 'You are a strict reviewer. Check the candidate answer(s) for factual errors, bugs, missing requirements and unsafe advice. If there is no material problem reply with exactly: OK. Otherwise reply with a short bullet list of concrete corrections or omissions. Do not rewrite the answer and do not include your reasoning process.';
const SYNTH_SYSTEM = 'You are the final answer writer. Using the candidate answer(s) and reviewer findings, write ONE complete, correct final answer for the user. Fix every issue the reviewer raised. Never mention drafts, reviewers, other models or this process.';
const LOCAL = {
  en: { remembered: 'Saved to your memory.', stopped: 'Generation stopped.', cacheNote: 'Answer reused from cache.' },
  ar: { remembered: 'تم الحفظ في ذاكرتك.', stopped: 'تم إيقاف التوليد.', cacheNote: 'تمت إعادة استخدام إجابة من الكاش.' }
};
const REMEMBER = /^\s*(?:remember(?: that|:)?|تذكر(?: أن| ان|:)?)\s+(.{3,400})$/is;

function createEngine(ctx) {
  const { db, cfg, connections, files, memory, chats } = ctx;

  const nextSeq = (chatId) => (db.get('SELECT COALESCE(MAX(seq),0)+1 n FROM messages WHERE chat_id=?', chatId).n);
  function addMessage(chatId, role, content, meta) {
    const id = db.id(); db.run('INSERT INTO messages(id,chat_id,seq,role,content,meta,created_at) VALUES(?,?,?,?,?,?,?)', id, chatId, nextSeq(chatId), role, content, meta ? JSON.stringify(meta) : null, Date.now());
    db.run('UPDATE chats SET updated_at=? WHERE id=?', Date.now(), chatId); return id;
  }
  const histOf = (chatId) => db.all('SELECT id,seq,role,content,meta FROM messages WHERE chat_id=? ORDER BY seq', chatId);

  /** One provider call with real measurement, logging and live-health feedback. */
  async function callModel(userId, chatId, cand, role, req, { stream = false, onDelta, signal } = {}) {
    const def = connections.defFor(userId, cand.providerId); const adapter = getAdapter(def);
    const conn = connections.connOf(def, connections.credential(cand.connectionId));
    const t0 = Date.now();
    try {
      let out;
      const full = { ...req, model: cand.modelId, signal };
      if (stream && adapter.streamChat) {
        let any = false;
        try { out = await adapter.streamChat(conn, full, (d) => { any = true; onDelta(d); }); }
        catch (e) { if (!any && e instanceof ProviderError && e.kind === 'INVALID_REQUEST') { out = await adapter.chat(conn, full); onDelta(out.content); } else throw e; }
      } else out = await adapter.chat(conn, full);
      if (!out.content || !out.content.trim()) throw new ProviderError('INVALID_REQUEST', 'Model returned an empty response');
      const latencyMs = Date.now() - t0; let usage = out.usage; let measured = !!usage && !usage.mock;
      if (!usage) { const input = TE.estimateTokens(JSON.stringify(req.messages) + (req.system || '')); const output = TE.estimateTokens(out.content); usage = { input, output, total: input + output }; }
      if (usage && usage.mock) measured = false;
      db.run('INSERT INTO model_usage(id,user_id,model_pk,connection_id,chat_id,role,status,latency_ms,input_tokens,output_tokens,measured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', db.id(), userId, cand.key, cand.connectionId, chatId, role, 'OK', latencyMs, usage.input, usage.output, measured ? 1 : 0, Date.now());
      return { content: out.content, usage, measured, latencyMs, finishReason: out.finishReason };
    } catch (e) {
      const aborted = e instanceof ProviderError && e.kind === 'ABORTED';
      const latencyMs = Date.now() - t0;
      if (!aborted) {
        db.run('INSERT INTO model_usage(id,user_id,model_pk,connection_id,chat_id,role,status,latency_ms,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', db.id(), userId, cand.key, cand.connectionId, chatId, role, e.kind || 'ERROR', latencyMs, String(e.message).slice(0, 300), Date.now());
        const st = e.kind === 'AUTH_FAILED' ? HEALTH.AUTH_FAILED : e.kind === 'RATE_LIMITED' ? HEALTH.RATE_LIMITED : e.kind === 'TIMEOUT' ? HEALTH.TIMEOUT : e.kind === 'UNAVAILABLE' ? HEALTH.UNAVAILABLE : HEALTH.DEGRADED;
        connections.recordLive(cand.key, st, e.message);
        if (e.kind === 'AUTH_FAILED') db.run(`UPDATE connections SET status='AUTH_FAILED', last_error=? WHERE id=?`, 'Key rejected during chat', cand.connectionId);
      }
      throw e;
    }
  }

  const fingerprint = (userId, settings, mem) => crypto.createHash('sha256').update([userId, settings.chat.systemPrompt, settings.language, mem.join('|')].join('\u0001')).digest('hex').slice(0, 24);

  /**
   * Core request pipeline.
   * opts: { userId, chatId?, text, attachmentIds?, critical?, modeOverride?, signal, emit(event,data), regenerateOf?, hidden? }
   */
  async function send(opts) {
    const { userId, text, signal, emit = () => {} } = opts;
    const settings = getSettings(db, userId); const lang = LOCAL[settings.language] || LOCAL.en;
    const started = Date.now();
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new MaxMindError('EMPTY', 'Message is empty.', { status: 400 });
    if (trimmed.length > 60000) throw new MaxMindError('TOO_LONG', 'Message is too long.', { status: 413 });

    let chat = opts.chatId ? chats.own(userId, opts.chatId) : null;
    if (!chat) { const c = chats.create(userId, trimmed.slice(0, 60)); chat = chats.own(userId, c.id); }
    const chatId = chat.id; emit('start', { chatId });
    const attachments = files.load(userId, opts.attachmentIds);
    const hasImage = attachments.some((a) => a.kind === 'image'); const docs = attachments.filter((a) => a.text != null);
    const history = histOf(chatId).filter((m) => !(opts.regenerateOf && m.id === opts.regenerateOf.userMsgId));
    const userMsgId = opts.regenerateOf ? opts.regenerateOf.userMsgId : (opts.hidden ? null : addMessage(chatId, 'user', trimmed, attachments.length ? { attachments: attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind })) } : null));

    // --- local command: "remember that ..." (no model call, zero tokens)
    const rm = !opts.hidden && !attachments.length && REMEMBER.exec(trimmed);
    if (rm && settings.memory.enabled) {
      memory.add(userId, rm[1], 'chat'); const reply = lang.remembered;
      const mid = addMessage(chatId, 'assistant', reply, { local: true, requestDetails: { local: true, models: [], tokens: { input: 0, output: 0, total: 0, measured: true }, cache: 'OFF', latencyMs: Date.now() - started } });
      emit('delta', { text: reply }); emit('done', { chatId, messageId: mid, content: reply, details: { local: true } }); return { chatId, messageId: mid, local: true };
    }

    const mem = settings.memory.enabled ? memory.recent(userId) : [];
    const system = [SYSTEM_BASE, settings.chat.systemPrompt, mem.length ? 'User memory (facts the user asked you to remember):\n- ' + mem.join('\n- ') : ''].filter(Boolean).join('\n\n');
    const docTokensBudget = settings.files.maxDocTokens;
    const docBlocks = docs.map((d) => ({ name: d.name, ...TE.selectDocumentChunks(d.text, trimmed, Math.floor(docTokensBudget / docs.length)) }));
    const docTokens = docBlocks.reduce((a, d) => a + TE.estimateTokens(d.text), 0);

    const task = analyzeTask({ text: trimmed, hasImage, hasDocument: docs.length > 0, extraTokens: docTokens, critical: !!opts.critical });
    emit('stage', { key: 'analyzing', task: { type: task.type, complexity: task.complexity } });

    // --- semantic (lexical-similarity) cache: standalone first messages only, never with attachments
    const cacheable = settings.tokens.cacheEnabled && !attachments.length && history.length === 0 && !opts.critical && !opts.hidden;
    const sig = fingerprint(userId, settings, mem);
    if (cacheable) {
      const rows = db.all('SELECT * FROM cache_entries WHERE user_id=? AND signature=? AND expires_at>? ORDER BY created_at DESC LIMIT 200', userId, sig, Date.now());
      const hit = TE.findCached(rows.map((r) => ({ id: r.id, query: r.query, queryNorm: r.query_norm, answer: r.answer, pks: JSON.parse(r.model_pks), expiresAt: r.expires_at })), trimmed, settings.tokens.cacheThreshold);
      if (hit) {
        const cands = connections.loadCandidates(userId); const okAll = hit.entry.pks.every((pk) => { const c = cands.find((x) => x.key === pk); return c && c.profile.enabled && c.health.state === 'HEALTHY' && c.connectionStatus === 'VALID'; });
        if (okAll) {
          db.run('UPDATE cache_entries SET hits=hits+1 WHERE id=?', hit.entry.id);
          const details = { models: [], modelsUsed: 0, teamCalls: 0, strategy: 'cache', tokens: { input: 0, output: 0, total: 0, measured: true }, estimatedCost: 0, costKnown: true, cache: 'HIT', cacheSimilarity: hit.similarity, compressionPct: 0, latencyMs: Date.now() - started, routing: { task: pubTask(task), note: lang.cacheNote } };
          const mid = addMessage(chatId, 'assistant', hit.entry.answer, { requestDetails: details });
          db.run('INSERT INTO token_usage(id,user_id,chat_id,message_id,input_tokens,output_tokens,total_tokens,est_cost,cache_hit,compression_pct,team_calls,models,measured,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', db.id(), userId, chatId, mid, 0, 0, 0, 0, 1, 0, 0, 0, 1, details.latencyMs, Date.now());
          emit('delta', { text: hit.entry.answer }); emit('done', { chatId, messageId: mid, content: hit.entry.answer, details }); return { chatId, messageId: mid, cache: true };
        }
      }
    }

    // --- routing
    const cands = connections.loadCandidates(userId);
    const { scored, excluded, weights } = scoreCandidates(task, cands, { weights: settings.router.weights });
    const mode = opts.modeOverride || settings.chat.mode;
    const plan = buildPlan({ mode, task, scored, excluded, settings: settings.team, selection: { manualKey: settings.team.manualModelKey, team: settings.team.selectedTeam } });
    const routing = { task: pubTask(task), mode, teamMode: settings.team.teamMode, weights, candidates: scored.slice(0, 8).map((s) => ({ key: s.candidate.key, label: label(s.candidate), score: s.score, breakdown: s.breakdown })),
      excluded: excluded.map((e) => ({ key: e.candidate.key, label: label(e.candidate), reasons: e.reasons })).slice(0, 30), plan: plan.ok ? { strategy: plan.strategy, steps: plan.steps, notes: plan.notes } : { error: plan.code } };
    db.run('INSERT INTO routing_decisions(id,user_id,chat_id,message_id,json,created_at) VALUES(?,?,?,?,?,?)', db.id(), userId, chatId, userMsgId, JSON.stringify(routing), Date.now());
    if (!plan.ok) { emit('error', { code: plan.code, message: plan.message, details: plan.details, chatId, routing }); return { chatId, error: plan.code }; }
    emit('route', { strategy: plan.strategy, steps: plan.steps, notes: plan.notes, task: routing.task });

    // --- context (token engine)
    const budget = { maxInputTokens: settings.tokens.maxInputTokens, maxOutputTokens: settings.chat.maxOutputTokens, priority: settings.tokens.priority };
    const userContent = (withDocs, docCap) => {
      let t = trimmed; if (withDocs && docBlocks.length) t += '\n\n' + docBlocks.map((d) => `[Attached file: ${d.name}${d.truncated ? ' — relevant excerpts' : ''}]\n${docCap ? TE.selectDocumentChunks(d.text, trimmed, docCap).text : d.text}`).join('\n\n');
      if (!withDocs || !hasImage) return t;
      return [{ type: 'text', text: t }, ...attachments.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', mime: a.mime, data: a.base64 }))];
    };
    const histMsgs = history.map((m) => ({ role: m.role, content: m.content }));
    const ctxBuilt = TE.buildContext({ history: histMsgs, summary: chat.summary, query: trimmed, systemTokens: TE.estimateTokens(system), userTokens: TE.estimateTokens(trimmed) + docTokens, budget, keepLast: settings.tokens.keepLast });
    const baseMessages = (ctxBuilt.messages.length && ctxBuilt.messages[ctxBuilt.messages.length - 1].role === 'user') ? ctxBuilt.messages.slice(0, -1) : ctxBuilt.messages;
    const mkReq = (role, extraSystem, withDocs = true) => ({ system: [system, extraSystem].filter(Boolean).join('\n\n'), messages: [...baseMessages, { role: 'user', content: userContent(withDocs) }], maxTokens: budget.maxOutputTokens, temperature: undefined });

    // --- execution
    const calls = []; const failures = []; let final = null; let finalCand = null; let streamed = false; let stopped = false;
    const byKey = new Map(scored.map((s) => [s.candidate.key, s.candidate]));
    const onDelta = (d) => { streamed = true; emit('delta', { text: d }); };
    const record = (role, cand, r, status, extra = {}) => calls.push({ role, key: cand.key, label: label(cand), status, latencyMs: r ? r.latencyMs : null, tokens: r ? r.usage : null, measured: r ? r.measured : null, ...extra });
    const tryCall = async (role, cand, req, o) => { try { const r = await callModel(userId, chatId, cand, role, req, { ...o, signal }); record(role, cand, r, 'OK', { conclusion: conclusion(role, r.content) }); return r; }
      catch (e) { if (e instanceof ProviderError && e.kind === 'ABORTED') throw e; record(role, cand, null, 'FAILED', { error: e.message, errorKind: e.kind }); failures.push({ role, label: label(cand), error: e.message, kind: e.kind }); return null; } };
    const stepCand = (s) => byKey.get(s.key);
    const fallbackPool = (exclude) => scored.map((s) => s.candidate).filter((c) => !exclude.includes(c.key));
    const fallbackAllowed = mode === 'auto' || mode === 'smart';

    try {
      const primaryStep = plan.steps.find((s) => ['primary', 'coder', 'analyst', 'researcher', 'writer', 'vision', 'generalist', 'document', 'planner', 'worker'].includes(s.role)) || plan.steps[0];
      const workerSteps = plan.steps.filter((s) => !['reviewer', 'synthesizer'].includes(s.role));
      const reviewerStep = plan.steps.find((s) => s.role === 'reviewer'); const synthStep = plan.steps.find((s) => s.role === 'synthesizer');

      if (plan.strategy === 'single') {
        emit('stage', { key: 'answering', model: primaryStep.label });
        let cand = stepCand(primaryStep); let r = await tryCall(primaryStep.role, cand, mkReq(primaryStep.role, ROLE_HINT[primaryStep.role]), { stream: true, onDelta });
        const tried = [cand.key];
        while (!r && !streamed && fallbackAllowed && tried.length < 3) { const next = fallbackPool(tried)[0]; if (!next) break; tried.push(next.key); emit('stage', { key: 'fallback', model: label(next) }); cand = next; r = await tryCall('primary(fallback)', next, mkReq('primary'), { stream: true, onDelta }); }
        if (r) { final = r.content; finalCand = cand; }
      } else {
        // drafts (parallel for multiple workers)
        emit('stage', { key: 'drafting', models: workerSteps.map((s) => s.label) });
        let drafts = (await Promise.all(workerSteps.map(async (s) => { const cand = stepCand(s); const r = await tryCall(s.role, cand, mkReq(s.role, ROLE_HINT[s.role]), { stream: false }); return r ? { step: s, cand, r } : null; }))).filter(Boolean);
        if (!drafts.length && fallbackAllowed) { const next = fallbackPool(workerSteps.map((s) => s.key))[0]; if (next) { emit('stage', { key: 'fallback', model: label(next) }); const r = await tryCall('primary(fallback)', next, mkReq('primary'), { stream: false }); if (r) drafts = [{ step: { role: 'primary', key: next.key, label: label(next) }, cand: next, r }]; } }
        if (!drafts.length) throw new MaxMindError('ALL_MODELS_FAILED', 'All selected models failed. See details.', { status: 502, details: failures });
        // review
        let findings = null;
        if (reviewerStep && stepCand(reviewerStep)) {
          emit('stage', { key: 'reviewing', model: reviewerStep.label });
          const excerpt = docBlocks.length ? '\n\n[File excerpts]\n' + docBlocks.map((d) => TE.selectDocumentChunks(d.text, trimmed, 500).text).join('\n') : '';
          const rq = { system: REVIEW_SYSTEM, messages: [{ role: 'user', content: `User request:\n${TE.compressText(trimmed, 3000)}${excerpt}\n\n` + drafts.map((d, i) => `Candidate answer ${i + 1}:\n${TE.compressText(d.r.content, 6000)}`).join('\n\n') }], maxTokens: 600 };
          const rv = await tryCall('reviewer', stepCand(reviewerStep), rq, { stream: false });
          if (rv) findings = rv.content.trim();
        }
        const ok = findings !== null && /^ok[.!\s]*$/i.test(findings);
        const bestDraft = drafts[0];
        if (drafts.length === 1 && (findings === null || ok)) { final = bestDraft.r.content; finalCand = bestDraft.cand; emit('delta', { text: final }); streamed = true; }
        else {
          // synthesize (stream). Prefer planned synthesizer if it produced a draft or is healthy; else best draft's model.
          const sc = (synthStep && stepCand(synthStep)) || bestDraft.cand;
          emit('stage', { key: 'synthesizing', model: label(sc) });
          const sq = { system: SYNTH_SYSTEM, messages: [{ role: 'user', content: `User request:\n${TE.compressText(trimmed, 3000)}\n\n` + drafts.map((d, i) => `Candidate answer ${i + 1}${drafts.length > 1 ? ` (${d.step.role})` : ''}:\n${TE.compressText(d.r.content, 6000)}`).join('\n\n') + (findings && !ok ? `\n\nReviewer findings:\n${findings}` : '') }], maxTokens: budget.maxOutputTokens };
          const sr = await tryCall('synthesizer', sc, sq, { stream: true, onDelta });
          if (sr) { final = sr.content; finalCand = sc; }
          else { final = bestDraft.r.content; finalCand = bestDraft.cand; emit('delta', { text: final }); streamed = true; failures.push({ role: 'synthesizer', note: 'synthesis failed; best draft returned' }); }
        }
      }
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'ABORTED') stopped = true; else if (e instanceof MaxMindError) { emit('error', { code: e.code, message: e.message, details: e.details || failures, chatId }); db.run('INSERT INTO team_runs(id,user_id,chat_id,message_id,strategy,steps,status,created_at) VALUES(?,?,?,?,?,?,?,?)', db.id(), userId, chatId, userMsgId, plan.strategy, JSON.stringify(calls), 'FAILED', Date.now()); return { chatId, error: e.code }; } else throw e;
    }

    if (!final && !stopped) {
      const manualLike = !fallbackAllowed;
      const msg = manualLike ? 'The selected model failed. No other model was substituted because you selected it explicitly.' : 'The model(s) failed to answer.';
      db.run('INSERT INTO team_runs(id,user_id,chat_id,message_id,strategy,steps,status,created_at) VALUES(?,?,?,?,?,?,?,?)', db.id(), userId, chatId, userMsgId, plan.strategy, JSON.stringify(calls), 'FAILED', Date.now());
      emit('error', { code: 'MODEL_FAILED', message: msg, details: failures, chatId }); return { chatId, error: 'MODEL_FAILED' };
    }

    // --- accounting (REAL usage; estimates are flagged)
    const ok = calls.filter((c) => c.status === 'OK');
    const tot = ok.reduce((a, c) => ({ input: a.input + (c.tokens ? c.tokens.input : 0), output: a.output + (c.tokens ? c.tokens.output : 0) }), { input: 0, output: 0 });
    const measured = ok.length > 0 && ok.every((c) => c.measured);
    let cost = 0, costKnown = ok.length > 0;
    for (const c of ok) { const cand = byKey.get(c.key); const v = cand && TE.estimateCost(c.tokens, cand.pricing); if (v == null) costKnown = false; else cost += v; }
    const distinct = new Set(calls.filter((c) => c.status === 'OK').map((c) => c.key)).size;
    const details = {
      strategy: plan.strategy, modelsUsed: distinct, teamCalls: calls.length, models: calls, failures,
      primary: primaryLabel(plan), reviewer: (plan.steps.find((s) => s.role === 'reviewer') || {}).label || null, synthesizer: finalCand ? label(finalCand) : null,
      tokens: { input: tot.input, output: tot.output, total: tot.input + tot.output, measured }, estimatedCost: costKnown ? +cost.toFixed(6) : null, costKnown,
      cache: cacheable ? 'MISS' : 'OFF', compressionPct: ctxBuilt.stats.compressionPct, context: ctxBuilt.stats, latencyMs: Date.now() - started, stopped,
      routing: { task: routing.task, mode, notes: plan.notes, top: routing.candidates.slice(0, 3), excluded: routing.excluded.slice(0, 10) }
    };
    const content = final || '';
    const mid = addMessage(chatId, 'assistant', content || lang.stopped, { requestDetails: details, stopped });
    db.run('INSERT INTO token_usage(id,user_id,chat_id,message_id,input_tokens,output_tokens,total_tokens,est_cost,cache_hit,compression_pct,team_calls,models,measured,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', db.id(), userId, chatId, mid, tot.input, tot.output, tot.input + tot.output, costKnown ? cost : null, 0, ctxBuilt.stats.compressionPct, calls.length, distinct, measured ? 1 : 0, details.latencyMs, Date.now());
    db.run('INSERT INTO team_runs(id,user_id,chat_id,message_id,strategy,steps,status,created_at) VALUES(?,?,?,?,?,?,?,?)', db.id(), userId, chatId, mid, plan.strategy, JSON.stringify(calls.map((c) => ({ role: c.role, label: c.label, status: c.status, latencyMs: c.latencyMs, conclusion: c.conclusion || null, error: c.error || null }))), stopped ? 'STOPPED' : failures.length ? 'PARTIAL' : 'OK', Date.now());
    if (cacheable && content && !stopped && !failures.length && finalCand) {
      const pks = [...new Set(ok.map((c) => c.key))]; db.run('INSERT INTO cache_entries(id,user_id,signature,query,query_norm,answer,model_pks,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)', db.id(), userId, sig, trimmed, TE.norm(trimmed).trim(), content, JSON.stringify(pks), Date.now(), Date.now() + settings.tokens.cacheTtlHours * 3600000);
    }
    maintainSummary(chatId, settings);
    if (!opts.chatId && !opts.regenerateOf) db.run('UPDATE chats SET title=? WHERE id=? AND title=?', trimmed.slice(0, 60).replace(/\s+/g, ' '), chatId, trimmed.slice(0, 60));
    emit('done', { chatId, messageId: mid, userMessageId: userMsgId, content, details });
    return { chatId, messageId: mid, details };
  }

  /** Rolling summary: extractive, local, zero API calls. Summarizes messages older than the kept window. */
  function maintainSummary(chatId, settings) {
    const c = db.get('SELECT summary, summary_upto FROM chats WHERE id=?', chatId); const all = histOf(chatId);
    const keep = settings.tokens.keepLast * 2; if (all.length <= keep) return;
    const total = all.reduce((a, m) => a + TE.msgTokens(m), 0); if (total < 1500) return;
    const older = all.slice(0, all.length - keep).filter((m) => m.seq > c.summary_upto); if (!older.length) return;
    db.run('UPDATE chats SET summary=?, summary_upto=? WHERE id=?', TE.extendSummary(c.summary, older), older[older.length - 1].seq, chatId);
  }

  const label = (c) => `${c.providerName} · ${c.connectionName} · ${c.modelId}`;
  const primaryLabel = (plan) => (plan.steps.find((s) => !['reviewer', 'synthesizer'].includes(s.role)) || plan.steps[0]).label;
  const pubTask = (t) => ({ type: t.type, complexity: t.complexity, requiredCaps: t.requiredCaps, estimatedInputTokens: t.estimatedInputTokens, signals: t.signals });
  const conclusion = (role, text) => { const s = String(text).replace(/\s+/g, ' ').trim(); return role === 'reviewer' ? s.slice(0, 300) : s.slice(0, 160); };

  /** Image generation — only through a model whose capability is provider-reported or user-declared. */
  async function generateImage(userId, { prompt, modelKey, chatId = null }) {
    const cands = connections.loadCandidates(userId).filter((c) => c.profile.enabled && c.connectionStatus === 'VALID' && (c.capabilities.imageGeneration === true || c.profile.capabilityOverrides.imageGeneration === true) && (!modelKey || c.key === modelKey));
    if (!cands.length) throw new MaxMindError('IMAGE_UNSUPPORTED', 'No enabled model supports image generation. Enable a model that reports image generation, or declare it in its profile.', { status: 501 });
    const cand = cands[0]; const def = connections.defFor(userId, cand.providerId); const adapter = getAdapter(def);
    if (!adapter.generateImage) throw new MaxMindError('IMAGE_UNSUPPORTED', `${def.name} adapter does not implement image generation.`, { status: 501 });
    const out = await adapter.generateImage(connections.connOf(def, connections.credential(cand.connectionId)), { model: cand.modelId, prompt: String(prompt).slice(0, 4000) });
    if (!out || out.status === 'UNSUPPORTED') throw new MaxMindError('IMAGE_UNSUPPORTED', 'Provider does not support image generation.', { status: 501 });
    db.run('INSERT INTO model_usage(id,user_id,model_pk,connection_id,chat_id,role,status,latency_ms,measured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', db.id(), userId, cand.key, cand.connectionId, chatId, 'image', 'OK', 0, 0, Date.now());
    if (out.b64) { const id = files.saveGeneratedImage(userId, chatId, Buffer.from(out.b64, 'base64')); return { attachmentId: id, model: label(cand) }; }
    return { url: out.url, model: label(cand) };
  }
  async function transcribe(userId, { audio, mime }) {
    const cands = connections.loadCandidates(userId).filter((c) => c.profile.enabled && c.connectionStatus === 'VALID' && /whisper|transcri/i.test(c.modelId));
    if (!cands.length) throw new MaxMindError('TRANSCRIBE_UNSUPPORTED', 'No enabled transcription model (e.g. whisper) is connected. Use browser speech recognition instead.', { status: 501 });
    const cand = cands[0]; const def = connections.defFor(userId, cand.providerId); const adapter = getAdapter(def);
    if (!adapter.transcribe) throw new MaxMindError('TRANSCRIBE_UNSUPPORTED', 'Adapter does not implement transcription.', { status: 501 });
    const r = await adapter.transcribe(connections.connOf(def, connections.credential(cand.connectionId)), { model: cand.modelId, audio, mime });
    if (!r || r.status === 'UNSUPPORTED') throw new MaxMindError('TRANSCRIBE_UNSUPPORTED', 'Provider does not support transcription.', { status: 501 });
    return { text: r.text, model: label(cand) };
  }
  return { send, generateImage, transcribe, addMessage, histOf };
}
module.exports = { createEngine };
