/** Add-context modal (AddContextModal) copy */
export default {
  /** Modal title */
  title: 'Add to Context',
  /** Import type switcher */
  mode: {
    paper: 'Paper',
    url: 'URL',
  },
  /** Import from the paper library */
  paper: {
    hint: 'Import from the paper library; the abstract is extracted automatically (AI-generated when missing)',
    searchPlaceholder: 'Search paper titles / keywords...',
    searching: 'Searching...',
    empty: 'No matching papers found',
    /** Fallback when a paper has no abstract */
    noAbstract: '(No abstract)',
  },
  /** Import from a URL */
  url: {
    hint: 'Fetch the page content and generate a summary (the beginning of the text is captured automatically when no API key is configured)',
    importing: 'Fetching and summarizing...',
    import: 'Import',
  },
  errors: {
    importFailed: 'Import failed. Please check the backend service.',
  },
} as const;
