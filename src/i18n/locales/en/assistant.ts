/** Assistant message rendering (AssistantMessage) copy */
export default {
  /** Tooltip for the inline [Source N] badge */
  inlineSource: {
    title: 'View source [{{n}}]',
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
  /** Sources section */
  sources: {
    title: 'Sources',
    /** Fallback name for a source entry without a context_id */
    currentPaper: 'Current paper',
    collapse: 'Click to collapse',
    expandFull: 'Click to expand the full source',
    locateInPaper: 'Locate this sentence in the paper',
    openInReaderTitle: 'Open this paper in the reader and locate the passage',
  },
} as const;
