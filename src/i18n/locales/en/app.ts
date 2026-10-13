/** App sidebar and global layout copy */
export default {
  brand: {
    /** Brand tagline: identical in both languages, kept as a product mark */
    tagline: 'AI Research Assistant',
  },
  nav: {
    home: 'Home',
    homeDesc: 'Workspaces',
    creation: 'Creation',
    creationDesc: 'LaTeX writing & preview',
    maintenance: 'Under maintenance — coming soon',
    research: 'Deep Research',
    researchDesc: 'Reading + RAG Q&A',
    explore: 'Explore',
    exploreDesc: 'Multi-source search',
    settings: 'Settings',
    settingsDesc: 'Data sources & LLM',
  },
  /** Tooltip shown when a nav entry is greyed out */
  navDisabledHint: 'Creation is under maintenance and unavailable',
  workspaceSwitcher: {
    noWorkspace: 'No workspace selected',
    switchWorkspace: 'Switch workspace',
    createWorkspace: 'Create a workspace',
  },
  /** Global top banner shown when the backend is unreachable */
  backend: {
    offline: 'Backend is not connected — start it first (run python app.py in the backend folder)',
    retry: 'Retry',
    retrying: 'Connecting to backend…',
  },
} as const;
