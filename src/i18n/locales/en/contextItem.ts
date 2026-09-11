/** Context item card (ContextItemCard) copy */
export default {
  /** Type badge */
  type: {
    paper: 'Paper',
    url: 'URL',
  },
  /** Generation status badge (states other than ready) */
  status: {
    generating: 'Generating',
    /** Badge when a paper's full text/PDF auto-fetch failed */
    unavailable: 'Unavailable',
    /** Badge tooltip fallback when no backend reason is available */
    unavailableTitle: 'Automatic full-text fetch failed for this paper. Click the refresh button to retry manually.',
  },
  /** Summary editing */
  summary: {
    empty: '(No summary — click to edit)',
    /** Title of the action button */
    edit: 'Edit summary',
    /** Tooltip on the summary text */
    editTitle: 'Click to edit the summary',
  },
  /** Tags */
  tag: {
    /** Placeholder of the new-tag input */
    placeholder: 'Tag',
    /** Label of the add-tag button */
    add: 'Tag',
  },
  /** Titles of the action buttons on the right */
  actions: {
    insertPaper: 'Insert the paper',
    /** Transfer this paper to the reader (Research view) */
    openInReader: 'Open in reader',
    viewContent: 'View full text on demand',
    collapseContent: 'Collapse full text',
    regenerate: 'Regenerate summary',
    /** Shown when unavailable: manually retry fetching the full text/PDF */
    retryPdf: 'Refresh manually and retry fetching the full text',
  },
  /** On-demand full-text area */
  content: {
    /** Heading line: {{kind}} is filled by webText / paperFullText */
    label: '{{kind}} (loaded on demand, not sent with Q&A)',
    webText: 'Web page text',
    paperFullText: 'Paper full text',
    empty: '(No full text)',
    loading: 'Loading...',
  },
  errors: {
    fetchContentFailed: 'Failed to fetch the full text',
    saveFailed: 'Save failed',
    addTagFailed: 'Failed to add the tag',
    removeTagFailed: 'Failed to remove the tag',
    refreshFailed: 'Refresh failed',
    retryPdfFailed: 'Failed to retry fetching the full text',
    deleteFailed: 'Delete failed',
  },
} as const;
