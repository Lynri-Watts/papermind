/** PDF reader (PdfViewer) copy */
export default {
  state: {
    loading: 'Loading PDF…',
    rendering: 'Rendering pages…',
    renderFailed: 'Unable to render PDF',
    loadFailed: 'Unable to load PDF',
  },
  toolbar: {
    /** Left toolbar hint: total pages and scroll instruction */
    pagesHint_one: '{{count}} page · Scroll with mouse wheel',
    pagesHint_other: '{{count}} pages · Scroll with mouse wheel',
    zoomOut: 'Zoom out',
    fitWidth: 'Fit width',
    zoomIn: 'Zoom in',
    rotate: 'Rotate',
  },
  selection: {
    /** Titles of the buttons on the text-selection floating toolbar */
    highlight: 'Highlight',
    note: 'Take note',
    addToContext: 'Add to context library',
    askAbout: 'Ask about this passage',
  },
} as const;