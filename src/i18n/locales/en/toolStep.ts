/** Tool step card (ToolStepCard) copy */
export default {
  title: {
    thinking: 'Thinking…',
    thought: 'Thought',
    running: 'Running: {{tool}}',
    skipped: 'Skipped {{tool}}',
    rejectedHint: '(answering from existing material)',
  },
  arg: {
    title: 'Title',
    abstract: 'Abstract / Body',
    keywords: 'Keywords',
    author: 'Author',
    fulltext: 'Full Text',
    yearFrom: 'From Year',
    yearTo: 'To Year',
    limit: 'Limit',
    paperIds: 'Papers',
  },
  argListSeparator: ', ',
  paper: {
    unknownAuthors: 'Unknown authors',
    citationCount_one: '{{count}} citation',
    citationCount_other: '{{count}} citations',
    openInReader: 'Open this paper in the reader',
    addToContext: 'Add to context library (persisted for later Q&A)',
  },
} as const;