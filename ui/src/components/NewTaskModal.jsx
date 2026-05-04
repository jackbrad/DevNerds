import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '../auth/api-client';
import { ALL_REPOS, ALL_PRIORITIES, ALL_CATEGORIES } from '../lib/constants';

export default function NewTaskModal({ onClose, onCreated, onSaved, editTask = null }) {
  const isEdit = !!editTask;
  const [stage, setStage] = useState(isEdit ? 'form' : 'brief'); // 'brief' → 'form'
  const [brief, setBrief] = useState('');
  const [generating, setGenerating] = useState(false);

  const [form, setForm] = useState(() => isEdit ? {
    id: editTask.id || '',
    title: editTask.title || '',
    priority: editTask.priority || 'P2',
    category: editTask.category || 'manual',
    description: editTask.description || '',
    acceptance: Array.isArray(editTask.acceptance)
      ? editTask.acceptance.join('\n')
      : (editTask.acceptance || ''),
    repo_hints: Array.isArray(editTask.repo_hints) ? [...editTask.repo_hints] : [],
  } : {
    id: '',
    title: '',
    priority: 'P2',
    category: 'manual',
    description: '',
    acceptance: '',
    repo_hints: [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');

  // AI assist state
  const [assisting, setAssisting] = useState(false);
  const [assistError, setAssistError] = useState('');
  const [suggestions, setSuggestions] = useState(null); // { suggestions, gaps, warnings }
  const [gapAnswers, setGapAnswers] = useState({}); // index -> answer string
  const [incorporatingIdx, setIncorporatingIdx] = useState(null);
  const [acceptedField, setAcceptedField] = useState(null); // brief flash on the form field that just got the suggestion

  const acceptanceLines = form.acceptance
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const descValid = form.description.length >= 100;
  const canSubmit =
    form.title.trim() &&
    descValid &&
    acceptanceLines.length > 0 &&
    !submitting;

  // Keyboard: Esc closes; Cmd/Ctrl+Enter generates (brief stage) or submits (form stage)
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (stage === 'brief' && brief.trim() && !generating) { handleGenerate(); }
        else if (stage === 'form' && canSubmit) { handleSubmit(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSubmit, form, stage, brief, generating]);

  async function handleGenerate() {
    if (!brief.trim() || generating) return;
    setGenerating(true);
    setAssistError('');
    try {
      const result = await apiFetch('/tasks/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'generate', brief: brief.trim() }),
      });
      if (result.error) {
        setAssistError(result.error);
        setGenerating(false);
        return;
      }
      const s = result.suggestions || {};
      setForm(f => ({
        ...f,
        title: s.title || f.title,
        description: s.description || f.description,
        category: s.category || f.category,
        priority: s.priority || f.priority,
        acceptance: Array.isArray(s.acceptance) && s.acceptance.length > 0
          ? s.acceptance.join('\n')
          : f.acceptance,
        repo_hints: Array.isArray(s.repo_hints) && s.repo_hints.length > 0
          ? s.repo_hints.map(h => h.repo).filter(Boolean)
          : f.repo_hints,
      }));
      // Keep gaps/warnings visible in the form stage; clear filled-in suggestions.
      setSuggestions({
        suggestions: {},
        gaps: result.gaps || [],
        warnings: result.warnings || [],
      });
      setStage('form');
    } catch (e) {
      setAssistError('AI assist unavailable — fill the form manually');
    } finally {
      setGenerating(false);
    }
  }

  function handleSkipBrief() {
    setStage('form');
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError('');
    try {
      if (isEdit) {
        await apiFetch('/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: editTask.id,
            title: form.title.trim(),
            priority: form.priority,
            category: form.category,
            description: form.description.trim(),
            acceptance: acceptanceLines,
            repo_hints: form.repo_hints,
          }),
        });
        if (onSaved) onSaved();
        onClose();
        return;
      }
      const body = {
        id: form.id.trim(),
        title: form.title.trim(),
        priority: form.priority,
        category: form.category,
        description: form.description.trim(),
        acceptance: acceptanceLines,
      };
      if (form.repo_hints.length > 0) body.repo_hints = form.repo_hints;
      const result = await apiFetch('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (onCreated) onCreated(result?.task);
      onClose();
    } catch (e) {
      setServerError(e.message || 'Unknown error');
      setSubmitting(false);
    }
  }

  function toggleRepo(repo) {
    setForm(f => ({
      ...f,
      repo_hints: f.repo_hints.includes(repo)
        ? f.repo_hints.filter(r => r !== repo)
        : [...f.repo_hints, repo],
    }));
  }

  function buildDraft() {
    return {
      title: form.title,
      description: form.description,
      category: form.category,
      priority: form.priority,
      acceptance: acceptanceLines,
      repo_hints: form.repo_hints,
    };
  }

  async function handleAssist() {
    setAssisting(true);
    setAssistError('');
    setSuggestions(null);
    setGapAnswers({});
    try {
      const result = await apiFetch('/tasks/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: buildDraft(), mode: 'refine' }),
      });
      if (result.error) {
        setAssistError(result.error);
      } else {
        setSuggestions(result);
      }
    } catch (e) {
      setAssistError('AI assist unavailable — fill the form manually');
    } finally {
      setAssisting(false);
    }
  }

  async function handleIncorporate(question, answerIdx) {
    const answer = gapAnswers[answerIdx] || '';
    if (!answer.trim()) return;
    setIncorporatingIdx(answerIdx);
    try {
      const result = await apiFetch('/tasks/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft: buildDraft(),
          mode: 'answer',
          question_answer: `Q: ${question}\nA: ${answer}`,
        }),
      });
      if (result.error) {
        setAssistError(result.error);
      } else {
        setSuggestions(result);
        setGapAnswers({});
      }
    } catch (e) {
      setAssistError('AI assist unavailable — fill the form manually');
    } finally {
      setIncorporatingIdx(null);
    }
  }

  function acceptSuggestion(field, value) {
    if (field === 'acceptance') {
      setForm(f => ({ ...f, acceptance: Array.isArray(value) ? value.join('\n') : value }));
    } else if (field === 'repo_hints') {
      // value is [{repo, why}, ...]
      setForm(f => ({ ...f, repo_hints: value.map(h => h.repo) }));
    } else {
      setForm(f => ({ ...f, [field]: value }));
    }
    // Remove the accepted suggestion so the card disappears — without this
    // visual signal, the form field updates silently up above and the panel
    // stays unchanged, making it look like the button didn't fire.
    setSuggestions(prev => prev ? {
      ...prev,
      suggestions: { ...prev.suggestions, [field]: null },
    } : prev);
    setAcceptedField(field);
    setTimeout(() => setAcceptedField(null), 1200);
  }

  const hasSuggestions = suggestions && (
    suggestions.suggestions?.title ||
    suggestions.suggestions?.description ||
    suggestions.suggestions?.acceptance ||
    suggestions.suggestions?.repo_hints ||
    suggestions.suggestions?.category ||
    suggestions.suggestions?.priority ||
    (suggestions.gaps && suggestions.gaps.length > 0) ||
    (suggestions.warnings && suggestions.warnings.length > 0)
  );

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-board-card border border-board-border rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl relative">

        {/* Loading overlay for AI assist / generate */}
        {(assisting || generating) && (
          <div className="absolute inset-0 z-10 bg-board-card/80 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center gap-3">
            <svg className="w-8 h-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-board-muted">
              {generating ? 'Claude is drafting your task...' : 'Claude is reviewing your draft...'}
            </span>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-board-border shrink-0">
          <h2 className="text-lg font-bold text-board-text tracking-tight">
            {isEdit ? `Edit ${editTask.id}` : (stage === 'brief' ? 'New Task — describe it' : 'New Task')}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-hover transition-all"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">

          {stage === 'brief' && (
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-2">
                  Describe the task <span className="text-board-subtle/60 normal-case font-normal tracking-normal text-[11px]">— Claude will draft a full spec you can edit</span>
                </label>
                <textarea
                  autoFocus
                  value={brief}
                  onChange={e => setBrief(e.target.value)}
                  placeholder={'e.g. "Add a dark-mode toggle to the operator dashboard header that persists across sessions"'}
                  rows={6}
                  className="w-full bg-board-bg border border-board-border rounded-xl px-4 py-3 text-sm text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 placeholder:text-board-subtle transition-all resize-none leading-relaxed"
                />
              </div>
              {assistError && (
                <div className="bg-status-awaiting/5 border border-status-awaiting/20 rounded-xl px-5 py-3 text-sm text-status-awaiting flex items-center justify-between gap-4">
                  <span>{assistError}</span>
                  <button
                    onClick={() => setAssistError('')}
                    className="text-status-awaiting/60 hover:text-status-awaiting transition-colors shrink-0 text-xs"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}

          {stage === 'form' && (<>

          {/* ID + Title row */}
          <div className="flex gap-4">
            <div className="w-[140px] shrink-0">
              <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-2">
                Task ID
              </label>
              <input
                type="text"
                value={form.id}
                onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
                placeholder="auto (GF-###)"
                disabled={isEdit}
                className="w-full bg-board-bg border border-board-border rounded-xl px-4 py-2.5 text-sm font-mono text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 placeholder:text-board-subtle transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-2">
                Title <span className="text-status-failed">*</span>
              </label>
              <input
                type="text"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="What needs to be done?"
                className={`w-full bg-board-bg border rounded-xl px-4 py-2.5 text-sm text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 placeholder:text-board-subtle transition-all ${acceptedField === 'title' ? 'border-accent ring-2 ring-accent/40' : 'border-board-border'}`}
              />
            </div>
          </div>

          {/* Priority + Category row */}
          <div className="flex gap-6 items-start">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-2">
                Priority
              </label>
              <div className="flex gap-2">
                {ALL_PRIORITIES.map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, priority: p }))}
                    className={`px-4 py-2 rounded-lg text-xs font-bold border transition-all duration-150 ${
                      form.priority === p
                        ? p === 'P0' ? 'bg-p0/20 text-p0 border-p0/30'
                          : p === 'P1' ? 'bg-p1/20 text-p1 border-p1/30'
                          : p === 'P2' ? 'bg-p2/20 text-p2 border-p2/30'
                          : 'bg-p3/20 text-p3 border-p3/30'
                        : 'border-board-border text-board-subtle hover:border-board-border-lit hover:text-board-muted'
                    }`}
                  >{p}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-2">
                Category
              </label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="bg-board-bg border border-board-border rounded-xl px-4 py-2.5 text-sm text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all cursor-pointer"
              >
                {ALL_CATEGORIES.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Description */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle">
                Description <span className="text-status-failed">*</span>
              </label>
              <span className={`text-[11px] font-mono tabular-nums transition-colors ${
                descValid ? 'text-status-closed' : form.description.length > 0 ? 'text-status-awaiting' : 'text-board-subtle'
              }`}>
                {form.description.length} / 100
              </span>
            </div>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Describe the task in detail (100+ characters required)..."
              rows={4}
              className={`w-full bg-board-bg border rounded-xl px-4 py-3 text-sm text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 placeholder:text-board-subtle transition-all resize-none leading-relaxed ${acceptedField === 'description' ? 'border-accent ring-2 ring-accent/40' : 'border-board-border'}`}
            />
          </div>

          {/* Acceptance criteria */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle">
                Acceptance Criteria <span className="text-status-failed">*</span>
              </label>
              <span className={`text-[11px] font-mono tabular-nums transition-colors ${
                acceptanceLines.length > 0 ? 'text-status-closed' : 'text-board-subtle'
              }`}>
                {acceptanceLines.length} {acceptanceLines.length === 1 ? 'criterion' : 'criteria'}
              </span>
            </div>
            <textarea
              value={form.acceptance}
              onChange={e => setForm(f => ({ ...f, acceptance: e.target.value }))}
              placeholder={"One criterion per line\nAll tests pass\nDeployment succeeds"}
              rows={4}
              className={`w-full bg-board-bg border rounded-xl px-4 py-3 text-sm text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 placeholder:text-board-subtle transition-all resize-none leading-relaxed font-mono ${acceptedField === 'acceptance' ? 'border-accent ring-2 ring-accent/40' : 'border-board-border'}`}
            />
          </div>

          {/* Repo hints */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-board-subtle mb-2">
              Repo Hints <span className="text-board-subtle/60 normal-case font-normal tracking-normal text-[11px]">(optional — leave empty to let PLAN decide)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {ALL_REPOS.map(repo => (
                <button
                  key={repo}
                  type="button"
                  onClick={() => toggleRepo(repo)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-150 ${
                    form.repo_hints.includes(repo)
                      ? 'bg-accent/15 text-accent border-accent/30'
                      : 'border-board-border text-board-subtle hover:border-board-border-lit hover:text-board-muted'
                  }`}
                >
                  {repo}
                </button>
              ))}
            </div>
          </div>

          {/* AI Assist error */}
          {assistError && (
            <div className="bg-status-awaiting/5 border border-status-awaiting/20 rounded-xl px-5 py-3 text-sm text-status-awaiting flex items-center justify-between gap-4">
              <span>{assistError}</span>
              <button
                onClick={() => setAssistError('')}
                className="text-status-awaiting/60 hover:text-status-awaiting transition-colors shrink-0 text-xs"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* AI Suggestions panel */}
          {hasSuggestions && (
            <div className="border border-board-border rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-board-bg border-b border-board-border flex items-center gap-2">
                <span className="text-accent text-sm">✨</span>
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-board-muted">Claude Suggestions</span>
              </div>

              <div className="px-5 py-4 space-y-4">

                {/* Warnings */}
                {suggestions.warnings?.length > 0 && (
                  <div className="bg-status-awaiting/8 border border-status-awaiting/20 rounded-lg px-4 py-3 space-y-1">
                    {suggestions.warnings.map((w, i) => (
                      <div key={i} className="text-xs text-status-awaiting flex gap-2">
                        <span className="shrink-0">!</span>
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Suggested title */}
                {suggestions.suggestions?.title && (
                  <SuggestionCard
                    label="Title"
                    value={suggestions.suggestions.title}
                    onAccept={() => acceptSuggestion('title', suggestions.suggestions.title)}
                  />
                )}

                {/* Suggested description */}
                {suggestions.suggestions?.description && (
                  <SuggestionCard
                    label="Description"
                    value={suggestions.suggestions.description}
                    onAccept={() => acceptSuggestion('description', suggestions.suggestions.description)}
                  />
                )}

                {/* Suggested acceptance */}
                {suggestions.suggestions?.acceptance && (
                  <SuggestionCard
                    label="Acceptance Criteria"
                    value={suggestions.suggestions.acceptance.join('\n')}
                    onAccept={() => acceptSuggestion('acceptance', suggestions.suggestions.acceptance)}
                  />
                )}

                {/* Suggested category */}
                {suggestions.suggestions?.category && (
                  <SuggestionCard
                    label="Category"
                    value={suggestions.suggestions.category}
                    onAccept={() => acceptSuggestion('category', suggestions.suggestions.category)}
                  />
                )}

                {/* Suggested priority */}
                {suggestions.suggestions?.priority && (
                  <SuggestionCard
                    label="Priority"
                    value={suggestions.suggestions.priority}
                    onAccept={() => acceptSuggestion('priority', suggestions.suggestions.priority)}
                  />
                )}

                {/* Suggested repo hints */}
                {suggestions.suggestions?.repo_hints?.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-board-subtle">Repo Hints</span>
                      <button
                        onClick={() => acceptSuggestion('repo_hints', suggestions.suggestions.repo_hints)}
                        className="text-[11px] font-semibold text-accent hover:text-accent/80 transition-colors px-3 py-1 rounded-lg bg-accent/10 hover:bg-accent/20"
                      >
                        Accept all
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {suggestions.suggestions.repo_hints.map((hint, i) => (
                        <div key={i} className="relative group">
                          <span className="px-3 py-1.5 rounded-lg text-xs font-medium border border-accent/30 bg-accent/10 text-accent cursor-default">
                            {hint.repo}
                          </span>
                          {hint.why && (
                            <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-20 w-56 bg-board-card border border-board-border rounded-lg px-3 py-2 text-[11px] text-board-muted shadow-xl">
                              {hint.why}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Gap questions */}
                {suggestions.gaps?.length > 0 && (
                  <div className="space-y-3">
                    <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-board-subtle">Gaps to clarify</span>
                    {suggestions.gaps.map((gap, i) => (
                      <div key={i} className="bg-board-bg rounded-lg px-4 py-3 space-y-2 border border-board-border">
                        <div className="text-xs text-board-text font-medium">{gap.question}</div>
                        {gap.why_it_matters && (
                          <div className="text-[11px] text-board-subtle">{gap.why_it_matters}</div>
                        )}
                        <textarea
                          value={gapAnswers[i] || ''}
                          onChange={e => setGapAnswers(prev => ({ ...prev, [i]: e.target.value }))}
                          placeholder="Your answer..."
                          rows={2}
                          className="w-full bg-board-card border border-board-border rounded-lg px-3 py-2 text-xs text-board-text outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 placeholder:text-board-subtle transition-all resize-none"
                        />
                        <button
                          onClick={() => handleIncorporate(gap.question, i)}
                          disabled={!gapAnswers[i]?.trim() || incorporatingIdx === i}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {incorporatingIdx === i ? (
                            <>
                              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              Asking Claude...
                            </>
                          ) : 'Ask Claude to incorporate'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

              </div>
            </div>
          )}

          {/* Server error */}
          {serverError && (
            <div className="bg-status-failed/5 border border-status-failed/15 rounded-xl px-5 py-4 text-sm text-status-failed">
              {serverError}
            </div>
          )}

          </>)}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-8 py-5 border-t border-board-border shrink-0">
          <span className="text-[11px] text-board-subtle">
            {stage === 'brief'
              ? <>Cmd+Enter to generate &nbsp;&middot;&nbsp; Esc to close</>
              : <>Cmd+Enter to submit &nbsp;&middot;&nbsp; Esc to close</>}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-board-muted hover:text-board-text hover:bg-board-hover border border-board-border transition-all duration-150"
            >
              Cancel
            </button>

            {stage === 'brief' && (
              <>
                <button
                  type="button"
                  onClick={handleSkipBrief}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold text-board-muted hover:text-board-text hover:bg-board-hover border border-board-border transition-all duration-150"
                >
                  Skip — I&apos;ll write it
                </button>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={generating || !brief.trim()}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-purple-500/15 to-accent/15 text-accent border border-accent/25 hover:from-purple-500/25 hover:to-accent/25 hover:border-accent/40 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {generating ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Drafting...
                    </>
                  ) : (
                    <>
                      <span>✨</span>
                      Generate draft
                    </>
                  )}
                </button>
              </>
            )}

            {stage === 'form' && (
              <>
                <button
                  type="button"
                  onClick={handleAssist}
                  disabled={assisting || !form.title.trim()}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold border transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r from-purple-500/10 to-accent/10 text-accent border-accent/20 hover:from-purple-500/20 hover:to-accent/20 hover:border-accent/40 hover:shadow-sm hover:shadow-accent/10"
                >
                  {assisting ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Thinking...
                    </>
                  ) : (
                    <>
                      <span>✨</span>
                      Refine with Claude
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold bg-accent/15 text-accent border border-accent/25 hover:bg-accent/25 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Creating...
                    </>
                  ) : (isEdit ? 'Save Changes' : 'Create Task')}
                </button>
              </>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function SuggestionCard({ label, value, onAccept }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-board-subtle">{label}</span>
        <button
          onClick={onAccept}
          className="text-[11px] font-semibold text-accent hover:text-accent/80 transition-colors px-3 py-1 rounded-lg bg-accent/10 hover:bg-accent/20"
        >
          Accept
        </button>
      </div>
      <div className="bg-board-bg border border-board-border rounded-lg px-4 py-3 text-xs text-board-text leading-relaxed whitespace-pre-wrap">
        {value}
      </div>
    </div>
  );
}
