/** Writing module (LaTeX editor and paper preview) copy */
export default {
  header: {
    title: 'LaTeX Editor',
  },
  toolbar: {
    /** Undo / redo */
    undo: 'Undo',
    redo: 'Redo',
    /** Inline formatting */
    bold: 'Bold',
    italic: 'Italic',
    list: 'List',
    link: 'Link',
    code: 'Code',
    math: 'Math',
    /** Block-level insert shortcuts */
    section: 'Section',
    subsection: 'Subsect',
    equation: 'Eq',
    /** AI actions */
    aiEdit: 'AI Edit',
    acceptAll: 'Accept All ({{count}})',
    /** Compile and save */
    compile: 'Compile',
    save: 'Save',
  },
  structure: {
    title: 'Document Structure',
    empty: 'No sections found',
  },
  suggestion: {
    /** AI suggestion type labels */
    improvement: 'Improvement',
    correction: 'Correction',
    addition: 'Addition',
    refinement: 'Refinement',
    fallback: 'Suggestion',
    /** Compare labels inside the hover tooltip */
    original: 'Original',
    suggested: 'Suggested',
    reject: 'Reject',
    accept: 'Accept',
  },
  preview: {
    title: 'Preview',
    zoomOut: 'Zoom Out',
    zoomIn: 'Zoom In',
    reset: 'Reset',
  },
} as const;
