/** User-visible copy produced inside the store (zustand): AI suggestion titles/descriptions,
 * data-block and context insertion messages. The store is not a component and cannot use
 * hooks, so it calls i18n.t('store:<relative key>') throughout. */
export default {
  suggestion: {
    clarity: {
      title: 'Clarity Improvement',
      description: 'Make this sentence more concise and academic',
    },
    academicTone: {
      title: 'Academic Tone',
      description: 'Enhance academic writing style',
    },
    contextualEnhancement: {
      title: 'Contextual Enhancement',
      description: 'Add citation context to strengthen the argument',
    },
    grammarCorrection: {
      title: 'Grammar Correction',
      description: 'Improve sentence structure',
    },
  },
  dataBlock: {
    notFound: 'Data block not found',
    unsupported: 'Unsupported block type',
    /** {{type}} is the data-block type token (Table / Chart / Equation / Figure) */
    insertedTitle: '{{type}} Inserted',
    insertedDescription: '{{title}} — AI-inserted from Data Blocks',
    addedToPaper: '{{type}} added to paper',
  },
  contextInsert: {
    suggestionTitle: 'Context Inserted: {{title}}',
    suggestionDescription: '{{title}} — AI-inserted from Context Library',
    success: 'Context inserted into the paper (before Conclusion; accept to apply)',
  },
} as const;