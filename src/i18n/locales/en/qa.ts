/** AI assistant panel (QAPanel) copy */
export default {
  tab: {
    qa: 'Q&A',
    context: 'Context',
    data: 'Data',
  },
  panel: {
    expand: 'Expand AI assistant',
    collapse: 'Collapse AI assistant',
    clearChat: 'Clear chat',
    /** Context tab header: specialized for adding an external web link */
    addExternalLink: 'Add external link',
  },
  focus: {
    reading: 'Reading focus: {{title}}',
    readingEmpty: 'Reading focus: no paper open',
    writing: 'Writing focus: AI can read the current LaTeX document',
    explore: 'Explore focus: based on the context library and external search',
  },
  quick: {
    heading: 'Quick prompts:',
    q1: 'Summarize the core contributions of the current paper',
    q2: "How does this paper's method differ from existing work?",
    q3: 'Rewrite the LaTeX passage above in a more academic style',
    q4: 'Search for and list the latest related research',
  },
  empty: {
    intro: 'One AI assistant for all three areas: ask about papers you read, literature you search, or LaTeX you write.',
  },
  input: {
    placeholder: 'One assistant for reading, search and writing...',
    stop: 'Stop generating',
  },
  toggle: {
    context: 'Context',
    contextHint: 'Enable/disable the context library',
    search: 'AI Search',
    searchHint: 'Enable/disable the AI literature-search tools (when on, the AI calls search/read tools autonomously in the ReAct loop, with no per-step confirmation)',
    manage: 'Manage',
    manageHint: 'Pin/exclude context items',
  },
  ctx: {
    pinnedCount: 'Pinned {{count}}',
    excludedCount: 'Excluded {{count}}',
    selectorEmpty: 'No context yet. Add a paper or web page on the "Context" tab first.',
    pin: 'Pin',
    pinned: 'Pinned',
    pinHint: 'Pin this item (always used in Q&A)',
    exclude: 'Exclude',
    excluded: 'Excluded',
    excludeHint: 'Exclude this item (the AI will not use it)',
    all: 'All ({{count}})',
    empty: 'The context library is empty. Click "+" in the top-right to import a paper from your library, or fetch a web page to generate a summary.',
  },
  data: {
    heading: 'AI-extracted data blocks',
    intro: 'Extracted automatically from context papers. Click "Add to Paper" to insert it into the LaTeX document (before Conclusion; can be accepted).',
    toolsHeading: 'Data analysis tools',
    addToPaper: 'Add to Paper',
    adding: 'Adding...',
    tool: {
      chart: 'Generate Chart',
      table: 'Create Table',
      stats: 'Statistical Analysis',
      export: 'Export Data',
    },
    blockType: {
      chart: 'Chart',
      table: 'Table',
      equation: 'Equation',
      figure: 'Figure',
      data: 'Data',
    },
  },
  stage: {
    connecting: 'Connecting to service...',
  },
  step: {
    execFailed: '{{tool}} failed to run',
    failed: '{{tool}} failed',
    stoppedNoResult: 'Generation stopped; this tool did not return a result',
    interruptedNoResult: 'Generation interrupted; this tool did not return a result',
  },
  error: {
    ragFailed: 'RAG Q&A failed',
    ragFailedWith: 'RAG Q&A failed: {{message}}',
    addContextFailed: 'Failed to add to context',
  },
  notice: {
    addedToContext: 'Added to context library',
    addedToContextWithTitle: 'Added to context library: {{title}}',
    openedInReader: 'Opened in reader: {{title}}',
    contextInserted: 'Context inserted into the paper (before Conclusion; can be accepted)',
    dataBlockAdded: '{{type}} added to paper',
  },
  label: {
    paper: 'paper',
  },
} as const;