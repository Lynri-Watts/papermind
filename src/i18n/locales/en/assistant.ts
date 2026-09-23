/** Assistant message rendering (AssistantMessage) copy */
export default {
  /** Tooltip for the inline [Source N] jump button */
  inlineSource: {
    locate: 'Locate source [{{n}}] in the paper',
  },
  /** ReAct / AI reasoning trail */
  trail: {
    /** Title of the live trail while streaming */
    reactTitle: 'ReAct reasoning',
    /** Title of the collapsed record after completion */
    aiTitle: 'AI reasoning',
    steps_one: '{{count}} step',
    steps_other: '{{count}} steps',
    thinking: 'AI is thinking…',
    expandHint: 'Click a step to expand its reasoning',
  },
  /** Shared placeholder while a stop request is still winding down */
  stopping: 'Stopping…',
  /** Placeholder while streaming but no content has arrived yet */
  stream: {
    processing: 'Working…',
  },
  /** Inline mid-sentence citation marker (numberless citation card) */
  citation: {
    /** Source not yet bound while streaming */
    verifying: 'Verifying source…',
    /** Failed card: the sentence cannot be found in the materials */
    failedTitle: 'Citation not verified',
    failedNote: 'This sentence could not be found verbatim in the provided materials; its source is unavailable.',
  },
  /** Sources section: source name + core quote only; chunk text is not expanded */
  sources: {
    title: 'Sources',
    /** Fallback name for a source entry without a context_id */
    currentPaper: 'Current paper',
    locateInPaper: 'Locate',
    openInReaderTitle: 'Open this paper in the reader and locate the passage',
  },
} as const;
