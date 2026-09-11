/** Home (workspace management) copy */
export default {
  /** Subtitle under the brand title */
  subtitle: 'Select a workspace to start your research, or create a new one',
  create: {
    title: 'New Workspace',
    namePlaceholder: 'Workspace name (required), e.g. Transformer Survey',
    descriptionPlaceholder: 'Short description (optional)',
    /** Primary action: create and select the new workspace */
    submit: 'Create & Select',
    /** Collapsed-state placeholder button */
    prompt: 'Click to create a new workspace',
    promptHint: 'Uploaded papers and drafts in progress are stored in the workspace',
  },
  list: {
    heading: 'My Workspaces ({{count}})',
    empty: 'No workspaces yet — create your first one to get started',
    /** Non-clickable badge on the currently selected workspace card */
    selected: 'Selected',
    /** Badge while switching to the workspace */
    selecting: 'Switching…',
    /** Fallback when a workspace has no description: file count */
    fileCount_one: '{{count}} file',
    fileCount_other: '{{count}} files',
    filesHeading: 'Files ({{count}})',
    filesEmpty: 'No files in this workspace yet. Use "Upload Literature" in the reader to add files to the current workspace.',
    /** Title of the expand-files button */
    viewFiles: 'View files',
    /** Title of the delete button */
    deleteWorkspace: 'Delete workspace',
  },
  errors: {
    nameRequired: 'Please enter a workspace name',
    createFailed: 'Failed to create workspace',
    deleteFailed: 'Failed to delete workspace',
    selectFailed: 'Failed to select workspace',
  },
  confirm: {
    delete: 'Delete workspace "{{name}}"? All files inside it will be deleted as well.',
  },
  time: {
    justNow: 'Just now',
    minutesAgo_one: '{{count}} minute ago',
    minutesAgo_other: '{{count}} minutes ago',
    hoursAgo_one: '{{count}} hour ago',
    hoursAgo_other: '{{count}} hours ago',
    monthDay: '{{month}}/{{day}}',
  },
} as const;
