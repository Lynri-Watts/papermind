/** Deep Research (reader): multi-tab PDF reading, metadata bar and upload dialog copy */
export default {
  header: {
    title: 'Reader',
    /** Workspace indicator shown when a workspace is active */
    workspace: 'Current workspace',
    noWorkspace: 'No workspace selected',
    upload: 'Upload paper',
    uploadTitle: 'Upload a local paper (PDF, etc.) to the current workspace and read it',
  },
  tabs: {
    /** Fallback title when a paper has no title */
    untitled: 'Untitled paper',
    close: 'Close tab',
    add: 'Add',
    addTitle: 'Upload a local paper (PDF, etc.) and read it',
  },
  meta: {
    unknownAuthors: 'Unknown authors',
    noPaper: 'No paper selected',
    unknownVenue: 'Unknown venue',
    /** Citation count; count drives pluralization, formatted holds the localized number */
    citations_one: '{{formatted}} citation',
    citations_other: '{{formatted}} citations',
    /** One-click add to the current workspace's context library (right side of the metadata bar) */
    addToContext: 'Add to Context',
    addToContextTitle: 'Add the paper in the current tab to the current workspace context library',
    addingToContext: 'Adding…',
    /** Non-clickable state when the paper is already curated */
    inContext: 'In Context',
    inContextTitle: 'This paper is already in the current workspace context library',
  },
  pdf: {
    preparing: 'Preparing PDF...',
    /** Fallback when the backend has no PDF for the paper */
    unavailable: 'No PDF is available for this paper',
    /** Fallback when probing PDF availability fails */
    fetchFailed: 'Unable to fetch the PDF for this paper',
    /** Failure panel: manually retry fetching */
    retry: 'Refresh & retry',
    retryTitle: 'Manually retry fetching this paper\u2019s PDF (no automatic retry after a failed fetch, to avoid rate limits)',
  },
  empty: {
    hint: 'Click "Upload paper" to open a local PDF, or search for a paper in Explore and open it to read',
  },
  paper: {
    /** Abstract heading in the metadata bar and detail area */
    abstract: 'Abstract',
    noAbstract: '(This paper has no abstract yet)',
    viewSource: 'View source: {{url}}',
  },
  upload: {
    panelTitle: 'Upload local paper',
    /** Shown in the dialog when no workspace is selected; <home> highlights the Home link */
    needWorkspaceHint: 'No workspace selected. Uploaded papers are stored in a workspace — go to <home>Home</home> to create or enter a workspace before uploading.',
    /** Pre-check hint for the upload entry */
    needWorkspace: 'No workspace selected — create or enter a workspace on the Home page first',
    pick: 'Click to choose a local file',
    supported: 'Supports PDF (opens for reading), .tex / .bib (writing), .txt / .md',
    uploading: 'Uploading...',
    failed: 'Upload failed',
    uploaded: 'Uploaded: {{path}}',
  },
  notice: {
    highlightAdded: 'Highlight added',
    noteAdded: 'Saved to notes',
    contextAdded: 'Saved as a context excerpt',
    contextFailed: 'Failed to add to context',
    /** One-click full-paper add succeeded */
    addedToContext: 'Added to context library: {{title}}',
    addToContextFailed: 'Failed to add to context',
    selectPaperFirst: 'Please select a paper first',
    /** Locate failure hint; snippet is the truncated quote text */
    locateFailed: 'Could not locate this citation in the paper: {{snippet}}',
  },
} as const;