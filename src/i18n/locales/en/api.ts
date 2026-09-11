/** API-layer (src/api/index.ts) errors and hints */
export default {
  stream: {
    /** Fallback for an SSE stage frame missing its label */
    processing: 'Processing...',
    /** Error when the browser lacks ReadableStream support */
    unsupported: 'This browser does not support streaming responses',
  },
  rag: {
    /** Fallback for an SSE error frame missing its message */
    failed: 'RAG Q&A failed',
  },
  note: {
    /** Local semantics: the backend exposes no note-edit endpoint */
    editUnsupported: 'Editing notes is not supported by the backend yet; please delete the note and create a new one.',
  },
} as const;
