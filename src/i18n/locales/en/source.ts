/** Data source badge (SourceBadge) copy */
export default {
  all: 'All Sources',
  badge: {
    title: 'Source: {{source}}',
  },
  status: {
    okTitle_one: '{{source}}: {{count}} match',
    okTitle_other: '{{source}}: {{count}} matches',
    empty: 'No match',
    emptyTitle: '{{source}}: No matching results',
    errorTitle: '{{source}}: {{error}}',
  },
} as const;