import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Settings as SettingsIcon, Database, Server, Loader2, CheckCircle2, XCircle, ArrowUp, ArrowDown,
  ExternalLink, Eye, EyeOff, Save, AlertCircle, KeyRound, Mail, Plug, Languages,
} from 'lucide-react';
import { getSettings, updateSettings, testSettingConnection } from '../api';
import { SettingsSnapshot, SettingsSource, SettingsTestResult } from '../types';
import { usePaperMindStore } from '../store';
import { SUPPORTED_LANGUAGES, LANGUAGE_LABELS, normalizeLanguage, changeLanguage } from '../i18n';

/** 单个连通性测试的运行态 */
interface TestState {
  loading: boolean;
  result: SettingsTestResult | null;
}

/** 该数据源是否可配置凭据（credential_label 为 null 表示无需配置，如 arXiv） */
const hasCredential = (s: SettingsSource): boolean => s.credential_label !== null;

/**
 * 设置页：管理论文数据源与大模型服务。
 *
 * 设计要点
 * --------
 * 1. 凭据只写后端本地数据库（app_settings 表，保存后立即热加载，无需重启），前端不持久化任何 key；
 *    密钥字段永不回显明文，只显示掩码与"是否已配置"。
 * 2. 测试按钮使用**已保存**的配置（后端按当前数据库设置发起真实请求），因此当该项存在
 *    未保存改动时禁用测试并提示先保存，避免"测的是旧配置"的误导。
 * 3. 界面语言由 i18next-browser-languagedetector 缓存进 localStorage（跨重启保留），
 *    无需写入后端设置。
 */
const SettingsPage: React.FC = () => {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const setSettings = usePaperMindStore((s) => s.setSettings);

  /** 当前界面语言（'zh-CN' 这类标识先归一化到受支持语言） */
  const currentLanguage = normalizeLanguage(i18n.language);

  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // 编辑态：LLM 草稿、凭据草稿（仅提交真正改动的字段）
  const [llmDraft, setLlmDraft] = useState({ base_url: '', model: '', api_key: '' });
  const [credDraft, setCredDraft] = useState<Record<string, string>>({});
  /** 被用户显式清除的密钥数据源 id（提交时传空串） */
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  /** 启用中的数据源 id，按聚合优先级排列（顺序即优先级） */
  const [order, setOrder] = useState<string[]>([]);
  /** 密钥明文的显隐（按"数据源 id 或 llm"键控） */
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  /** 连通性测试状态（键为 'llm' 或数据源 id） */
  const [tests, setTests] = useState<Record<string, TestState>>({});

  /** 用后端快照重置全部编辑态（首次加载与保存成功后调用） */
  const resetDrafts = useCallback((snap: SettingsSnapshot) => {
    setLlmDraft({ base_url: snap.llm.base_url, model: snap.llm.model, api_key: '' });
    const creds: Record<string, string> = {};
    for (const s of snap.sources) {
      if (!hasCredential(s)) continue;
      // 密钥不回显：留空表示"不修改"；非密钥（邮箱）回显当前值便于编辑
      creds[s.id] = s.secret ? '' : (s.value ?? '');
    }
    setCredDraft(creds);
    setCleared(new Set());
    setOrder(snap.sources.filter((s) => s.enabled).map((s) => s.id));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getSettings();
        if (cancelled) return;
        setSnapshot(snap);
        setSettings(snap);
        resetDrafts(snap);
      } catch (e) {
        // 只保存后端错误信息；拿不到信息时置 null，渲染时落到兜底文案。
        // 这里不调用 t：t 随语言变化而变身份，放进依赖会在切换语言时重新拉取设置并丢弃草稿。
        if (!cancelled) setLoadError(e instanceof Error ? e.message : null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [setSettings, resetDrafts]);

  /** 已启用列表（按当前顺序）/ 未启用列表，用于渲染与排序 */
  const enabledList = useMemo(
    () => order.map((id) => snapshot?.sources.find((s) => s.id === id)).filter((s): s is SettingsSource => Boolean(s)),
    [order, snapshot]
  );
  const disabledList = useMemo(
    () => (snapshot?.sources ?? []).filter((s) => !order.includes(s.id)),
    [snapshot, order]
  );

  /** 后端快照中的启用顺序（作为"顺序是否被改动"的基准） */
  const baselineOrder = useMemo(
    () => (snapshot?.sources ?? []).filter((s) => s.enabled).map((s) => s.id).join(','),
    [snapshot]
  );
  const orderDirty = snapshot ? order.join(',') !== baselineOrder : false;

  const sourceDirty = useCallback((s: SettingsSource): boolean => {
    if (!snapshot || !hasCredential(s)) return false;
    if (cleared.has(s.id)) return true;
    const draft = credDraft[s.id] ?? '';
    // 密钥：草稿非空即为改动；非密钥：与快照值不同即为改动
    return s.secret ? draft.trim() !== '' : draft !== (s.value ?? '');
  }, [snapshot, cleared, credDraft]);

  const llmDirty = snapshot
    ? (llmDraft.base_url !== snapshot.llm.base_url
       || llmDraft.model !== snapshot.llm.model
       || llmDraft.api_key.trim() !== '')
    : false;

  const dirty = orderDirty || llmDirty || (snapshot?.sources ?? []).some(sourceDirty);

  const toggleReveal = (key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const moveSource = (id: string, dir: -1 | 1) => {
    setOrder((prev) => {
      const i = prev.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const toggleEnabled = (id: string, enable: boolean) => {
    setOrder((prev) => {
      if (enable) return prev.includes(id) ? prev : [...prev, id];
      return prev.filter((x) => x !== id);
    });
  };

  const handleReset = () => {
    if (!snapshot) return;
    resetDrafts(snapshot);
    setSaveMessage(null);
  };

  const handleSave = async () => {
    if (!snapshot || saving) return;
    if (order.length === 0) {
      setSaveMessage({ kind: 'error', text: t('error.atLeastOneSource') });
      return;
    }
    const payload: Parameters<typeof updateSettings>[0] = {};

    const llm: NonNullable<typeof payload.llm> = {};
    if (llmDraft.base_url !== snapshot.llm.base_url) llm.base_url = llmDraft.base_url.trim();
    if (llmDraft.model !== snapshot.llm.model) llm.model = llmDraft.model.trim();
    if (llmDraft.api_key.trim() !== '') llm.api_key = llmDraft.api_key.trim();
    if (Object.keys(llm).length > 0) payload.llm = llm;

    const credentials: Record<string, string> = {};
    for (const s of snapshot.sources) {
      if (!hasCredential(s)) continue;
      if (cleared.has(s.id)) {
        credentials[s.id] = '';   // 显式清除
        continue;
      }
      const draft = credDraft[s.id] ?? '';
      if (s.secret) {
        if (draft.trim() !== '') credentials[s.id] = draft.trim();
      } else if (draft !== (s.value ?? '')) {
        credentials[s.id] = draft.trim();
      }
    }
    if (Object.keys(credentials).length > 0) payload.credentials = credentials;
    if (orderDirty) payload.source_order = order;

    if (Object.keys(payload).length === 0) {
      setSaveMessage({ kind: 'error', text: t('error.noChanges') });
      return;
    }

    setSaving(true);
    setSaveMessage(null);
    try {
      const next = await updateSettings(payload);
      setSnapshot(next);
      setSettings(next);
      resetDrafts(next);
      setSaveMessage({ kind: 'ok', text: t('save.success') });
    } catch (e) {
      setSaveMessage({ kind: 'error', text: e instanceof Error ? e.message : t('save.failed') });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (target: string) => {
    setTests((prev) => ({ ...prev, [target]: { loading: true, result: null } }));
    try {
      const result = await testSettingConnection(target);
      setTests((prev) => ({ ...prev, [target]: { loading: false, result } }));
    } catch (e) {
      setTests((prev) => ({
        ...prev,
        [target]: { loading: false, result: { ok: false, message: e instanceof Error ? e.message : t('test.failed') } },
      }));
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-background text-textSecondary">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span className="text-sm">{t('loading')}</span>
      </div>
    );
  }

  if (loadError || !snapshot) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="flex flex-col items-center text-center px-8">
          <AlertCircle className="w-10 h-10 text-red-400/70 mb-3" />
          <p className="text-sm text-textSecondary">{loadError || t('loadError')}</p>
        </div>
      </div>
    );
  }

  /** 渲染单个数据源卡片（已启用者附排序按钮，未启用者附启用按钮） */
  const renderSource = (s: SettingsSource, index: number, enabled: boolean) => {
    const test = tests[s.id];
    const dirtyItem = sourceDirty(s);
    return (
      <div key={s.id} className="bg-surface border border-border rounded-xl p-4">
        <div className="flex items-start gap-3">
          {enabled && (
            <div className="flex flex-col items-center gap-0.5 pt-0.5">
              <button
                onClick={() => moveSource(s.id, -1)}
                disabled={index === 0}
                className="p-1 rounded hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors disabled:opacity-30"
                title={t('sources.moveUp')}
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] text-textSecondary font-mono">{index + 1}</span>
              <button
                onClick={() => moveSource(s.id, 1)}
                disabled={index === enabledList.length - 1}
                className="p-1 rounded hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors disabled:opacity-30"
                title={t('sources.moveDown')}
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-text text-sm">{s.label}</span>
              {enabled ? (
                <span className="px-1.5 py-0.5 rounded text-[11px] bg-accent/10 text-accent">{t('sources.enabled')}</span>
              ) : (
                <span className="px-1.5 py-0.5 rounded text-[11px] bg-background text-textSecondary border border-border">{t('sources.disabled')}</span>
              )}
              {hasCredential(s) && (
                <span className={`px-1.5 py-0.5 rounded text-[11px] ${
                  s.configured
                    ? 'bg-primary/10 text-primary'
                    : 'bg-background text-textSecondary border border-border'
                }`}>
                  {s.configured ? t('sources.credentialConfigured') : t('sources.credentialMissing')}
                </span>
              )}
              {s.help_url && (
                <a
                  href={s.help_url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-[11px] text-textSecondary hover:text-primary transition-colors"
                >
                  {hasCredential(s) ? t('sources.getApiKey') : t('sources.docs')}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            <p className="text-xs text-textSecondary mt-1.5 leading-relaxed">{s.description}</p>

            {hasCredential(s) && (
              <div className="mt-3">
                <label className="block text-[11px] font-medium text-textSecondary mb-1">
                  {s.credential_label}
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 min-w-0">
                    {s.secret
                      ? <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textSecondary" />
                      : <Mail className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textSecondary" />}
                    <input
                      type={s.secret && !revealed.has(s.id) ? 'password' : 'text'}
                      value={credDraft[s.id] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setCredDraft((prev) => ({ ...prev, [s.id]: v }));
                        setCleared((prev) => { const n = new Set(prev); n.delete(s.id); return n; });
                      }}
                      placeholder={s.configured
                        ? (s.secret
                            ? t('placeholder.configuredRemain', { value: s.value })
                            : t('placeholder.empty'))
                        : (s.secret ? t('placeholder.secret') : t('placeholder.mailto'))}
                      className="w-full pl-8 pr-2 py-2 bg-background border border-border rounded-lg text-sm text-text placeholder-textSecondary focus:outline-none focus:border-primary transition-colors"
                    />
                  </div>
                  {s.secret && (
                    <button
                      onClick={() => toggleReveal(s.id)}
                      className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors flex-shrink-0"
                      title={revealed.has(s.id) ? t('reveal.hide') : t('reveal.show')}
                    >
                      {revealed.has(s.id) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  )}
                  {s.configured && (
                    <button
                      onClick={() => {
                        setCredDraft((prev) => ({ ...prev, [s.id]: '' }));
                        setCleared((prev) => new Set(prev).add(s.id));
                      }}
                      className={`px-2.5 py-2 rounded-lg text-xs border transition-colors flex-shrink-0 ${
                        cleared.has(s.id)
                          ? 'bg-red-500/10 border-red-500/40 text-red-400'
                          : 'bg-background border-border text-textSecondary hover:text-text hover:border-primary/40'
                      }`}
                      title={t('sources.clearHint')}
                    >
                      {cleared.has(s.id) ? t('sources.pendingClear') : t('sources.clear')}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <button
                onClick={() => runTest(s.id)}
                disabled={test?.loading || dirtyItem}
                title={dirtyItem ? t('test.sourceDirtyHint') : t('test.sourceHint')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border hover:border-primary/40 text-textSecondary hover:text-text text-xs font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {test?.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                {t('test.button')}
              </button>
              {enabled ? (
                <button
                  onClick={() => toggleEnabled(s.id, false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-background border border-border text-textSecondary hover:text-text hover:border-primary/40 transition-colors"
                >
                  {t('common:action.disable')}
                </button>
              ) : (
                <button
                  onClick={() => toggleEnabled(s.id, true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 transition-colors"
                >
                  {t('common:action.enable')}
                </button>
              )}
              <TestResult state={test} />
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="max-w-3xl mx-auto px-8 py-10 pb-28">
        {/* 标题区 */}
        <div className="flex items-center gap-4 mb-8">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
            <SettingsIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-text">{t('title')}</h1>
            <p className="text-sm text-textSecondary">{t('subtitle')}</p>
          </div>
        </div>

        {/* 界面语言：切换即时生效，选择由 i18next detector 缓存进 localStorage（跨重启保留） */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <Languages className="w-4 h-4 text-secondary" />
            <h2 className="font-semibold text-text">{t('language.title')}</h2>
          </div>
          <p className="text-xs text-textSecondary mb-3 leading-relaxed">{t('language.description')}</p>
          <div className="bg-surface border border-border rounded-xl p-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('language.title')}>
              {SUPPORTED_LANGUAGES.map((lang) => {
                const active = currentLanguage === lang;
                return (
                  <button
                    key={lang}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => { void changeLanguage(lang); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active
                        ? 'bg-primary/10 border-primary/30 text-primary'
                        : 'bg-background border-border text-textSecondary hover:text-text hover:border-primary/40'
                    }`}
                  >
                    {LANGUAGE_LABELS[lang]}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* 大模型服务 */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <Server className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-text">{t('llm.title')}</h2>
          </div>
          <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-medium text-textSecondary mb-1">{t('llm.baseUrl')}</span>
                <input
                  type="text"
                  value={llmDraft.base_url}
                  onChange={(e) => setLlmDraft((p) => ({ ...p, base_url: e.target.value }))}
                  placeholder="https://api.openai.com/v1"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text placeholder-textSecondary focus:outline-none focus:border-primary transition-colors"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-textSecondary mb-1">{t('llm.model')}</span>
                <input
                  type="text"
                  value={llmDraft.model}
                  onChange={(e) => setLlmDraft((p) => ({ ...p, model: e.target.value }))}
                  placeholder="gpt-4o-mini"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text placeholder-textSecondary focus:outline-none focus:border-primary transition-colors"
                />
              </label>
            </div>
            <div>
              <span className="block text-[11px] font-medium text-textSecondary mb-1">{t('llm.apiKey')}</span>
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textSecondary" />
                  <input
                    type={revealed.has('llm') ? 'text' : 'password'}
                    value={llmDraft.api_key}
                    onChange={(e) => setLlmDraft((p) => ({ ...p, api_key: e.target.value }))}
                    placeholder={snapshot.llm.api_key_configured
                      ? t('placeholder.configuredRemain', { value: snapshot.llm.api_key_hint })
                      : t('placeholder.secret')}
                    className="w-full pl-8 pr-2 py-2 bg-background border border-border rounded-lg text-sm text-text placeholder-textSecondary focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <button
                  onClick={() => toggleReveal('llm')}
                  className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors flex-shrink-0"
                  title={revealed.has('llm') ? t('reveal.hide') : t('reveal.show')}
                >
                  {revealed.has('llm') ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => runTest('llm')}
                disabled={tests.llm?.loading || llmDirty}
                title={llmDirty ? t('test.llmDirtyHint') : t('test.llmHint')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border hover:border-primary/40 text-textSecondary hover:text-text text-xs font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {tests.llm?.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                {t('test.button')}
              </button>
              <TestResult state={tests.llm} />
            </div>
          </div>
        </section>

        {/* 数据源 */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Database className="w-4 h-4 text-accent" />
            <h2 className="font-semibold text-text">{t('sources.title')}</h2>
          </div>
          <p className="text-xs text-textSecondary mb-3 leading-relaxed">
            {t('sources.description')}
          </p>
          <div className="space-y-3">
            {enabledList.map((s, i) => renderSource(s, i, true))}
          </div>
          {disabledList.length > 0 && (
            <>
              <div className="flex items-center gap-3 my-4">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] text-textSecondary">{t('sources.disabled')}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="space-y-3">
                {disabledList.map((s) => renderSource(s, -1, false))}
              </div>
            </>
          )}
        </section>
      </div>

      {/* 底部保存条（悬浮，保持在视口内） */}
      <div className="sticky bottom-0 border-t border-border bg-surface/95 backdrop-blur px-8 py-3">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          {saveMessage ? (
            <span className={`flex items-center gap-1.5 text-xs ${
              saveMessage.kind === 'ok' ? 'text-accent' : 'text-red-400'
            }`}>
              {saveMessage.kind === 'ok'
                ? <CheckCircle2 className="w-3.5 h-3.5" />
                : <AlertCircle className="w-3.5 h-3.5" />}
              {saveMessage.text}
            </span>
          ) : (
            <span className="text-xs text-textSecondary">
              {dirty ? t('footer.dirty') : t('footer.clean')}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleReset}
              disabled={!dirty || saving}
              className="px-4 py-2 rounded-lg text-sm text-textSecondary hover:text-text hover:bg-background transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('footer.discard')}
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {t('common:action.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** 连通性测试结果徽标（成功显示耗时，失败显示原因） */
const TestResult: React.FC<{ state?: TestState }> = ({ state }) => {
  const { t } = useTranslation('settings');
  if (!state?.result) return null;
  const { ok, message, latency_ms } = state.result;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${ok ? 'text-accent' : 'text-red-400'}`}
      title={message}
    >
      {ok ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 flex-shrink-0" />}
      <span className="truncate max-w-[280px]">
        {message}{ok && latency_ms != null ? ` ${t('test.latency', { ms: latency_ms })}` : ''}
      </span>
    </span>
  );
};

export default SettingsPage;
