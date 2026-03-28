export function createPlanTemplate(workspaceName?: string): string {
  const projectName = workspaceName?.trim() || 'Workspace Project';
  return `{
  // File mode plan for Ticket Manager.
  "version": 1,
  "currentUser": "Alex Agent",
  "projects": [
    {
      "key": "APP",
      "name": "${projectName}"
    }
  ],
  "workflow": {
    "statuses": [
      { "name": "To Do", "category": "todo" },
      { "name": "In Progress", "category": "indeterminate" },
      { "name": "Blocked", "category": "indeterminate" },
      { "name": "Done", "category": "done" }
    ]
  },
  "boards": [
    {
      "id": "board-app",
      "name": "${projectName} Board",
      "type": "plan",
      "projectKey": "APP",
      "projectName": "${projectName}",
      "locationName": "Workspace Plan",
      "issueKeys": ["APP-100", "APP-101", "APP-102", "APP-103"],
      "columnStatusOrder": ["To Do", "In Progress", "Blocked", "Done"]
    }
  ],
  "items": [
    {
      "key": "APP-100",
      "summary": "Define the primary feature",
      "type": "Feature",
      "status": "In Progress",
      "projectKey": "APP",
      "projectName": "${projectName}",
      "assignee": "Alex Agent",
      "priority": "High",
      "updated": "2026-03-28T00:00:00.000Z",
      "description": "Top-level feature used to group the initial stories, tasks, and bugs."
    },
    {
      "key": "APP-101",
      "summary": "Write the first story",
      "type": "Story",
      "status": "To Do",
      "projectKey": "APP",
      "projectName": "${projectName}",
      "assignee": "Alex Agent",
      "priority": "High",
      "updated": "2026-03-28T00:10:00.000Z",
      "description": "A child story under the main feature.",
      "parent": "APP-100"
    },
    {
      "key": "APP-102",
      "summary": "Complete the initial task",
      "type": "Task",
      "status": "In Progress",
      "projectKey": "APP",
      "projectName": "${projectName}",
      "assignee": "Jordan Builder",
      "priority": "Medium",
      "updated": "2026-03-28T00:20:00.000Z",
      "description": "A concrete implementation task under the feature.",
      "parent": "APP-100"
    },
    {
      "key": "APP-103",
      "summary": "Track the first bug",
      "type": "Bug",
      "status": "Blocked",
      "projectKey": "APP",
      "projectName": "${projectName}",
      "assignee": "Alex Agent",
      "priority": "Critical",
      "updated": "2026-03-28T00:30:00.000Z",
      "description": "A blocker that prevents the feature from finishing.",
      "parent": "APP-100"
    }
  ]
}
`;
}
