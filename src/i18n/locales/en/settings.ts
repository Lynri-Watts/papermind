/** Settings page: interface language, paper data sources and LLM service copy */
export default {
  title: 'Settings',
  /** `.env` is wrapped in <env> to keep its monospace styling (Trans named component) */
  subtitle: 'Manage paper data sources and LLM services; credentials are stored in the backend <env>.env</env> and take effect immediately',
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
    success: 'Saved to the backend .env and applied immediately (no restart needed)',
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
