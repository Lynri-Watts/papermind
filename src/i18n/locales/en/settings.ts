/** Settings page: interface language, paper data sources and LLM service copy */
export default {
  title: 'Settings',
  subtitle: 'Manage paper data sources and LLM services; credentials are stored only in the local backend database and take effect immediately',
  loading: 'Loading settings...',
  /** Fallback when loading fails; the backend error message is shown as-is when present */
  loadError: 'Unable to read settings — please make sure the backend service is running',

  /** Interface language (labels come from LANGUAGE_LABELS, written in their own language) */
  language: {
    title: 'Interface language',
    description: 'Applies immediately and remembers your choice',
  },

  llm: {
    title: 'LLM service',
    /** Field names follow the API terminology and stay untranslated */
    baseUrl: 'Base URL',
    model: 'Model name',
    apiKey: 'API Key',
  },

  /** How the AI reads paper/context text during Q&A (cost vs. evidence completeness) */
  reading: {
    title: 'AI reading granularity',
    description: 'How the AI reads paper text when answering — trade off token/time cost against evidence completeness. Passages from multiple keyword lookups are merged and de-duplicated, never overwritten.',
    auto: {
      label: 'Automatic',
      hint: 'Let the model decide per question: keyword lookup for simple ones, full text for complex ones',
    },
    full: {
      label: 'Completeness first',
      hint: 'Read the whole text in one go whenever evidence is needed — most complete evidence and most reliable citation checks, at the highest token/time cost',
    },
    passages: {
      label: 'Economy first',
      hint: 'Fetch only keyword-matching passages — lowest cost; evidence spread across sections may require several follow-up lookups',
    },
  },

  /** Credential/key input placeholders (shared by data sources and LLM) */
  placeholder: {
    /** When configured, only the mask is echoed; blank means "keep unchanged" */
    configuredRemain: 'Configured {{value}} (leave blank to keep)',
    secret: 'Paste your API Key',
    mailto: 'Add an email to join the polite pool',
    empty: 'Not set',
  },

  reveal: {
    show: 'Show',
    hide: 'Hide',
  },

  test: {
    button: 'Test connection',
    sourceHint: 'Run a real search with the saved configuration',
    llmHint: 'Run a minimal chat with the saved configuration',
    sourceDirtyHint: 'This item has unsaved changes — save before testing',
    llmDirtyHint: 'LLM configuration has unsaved changes — save before testing',
    failed: 'Test failed',
    /** Success suffix: latency (the leading space is added at the call site to keep the original rendering) */
    latency: '· {{ms}}ms',
  },

  save: {
    success: 'Saved to the local backend database and applied immediately (no restart needed)',
    failed: 'Failed to save',
  },

  error: {
    atLeastOneSource: 'At least one data source must be enabled',
    noChanges: 'Nothing to save',
  },

  sources: {
    title: 'Paper data sources',
    description: 'The order sets the aggregation priority for multi-source search (topmost wins); disabled sources are skipped in retrieval and stay out of the Explore source filter.',
    /** Card status badges; disabled is also used for the disabled-sources divider */
    enabled: 'Enabled',
    disabled: 'Disabled',
    credentialConfigured: 'Credential set',
    credentialMissing: 'No credential',
    getApiKey: 'Get an API Key',
    docs: 'Docs',
    moveUp: 'Increase priority',
    moveDown: 'Decrease priority',
    clear: 'Clear',
    pendingClear: 'Will clear',
    clearHint: 'Clear this credential on save',
  },

  footer: {
    dirty: 'You have unsaved changes',
    clean: 'Configuration matches the backend',
    discard: 'Discard changes',
  },
} as const;
