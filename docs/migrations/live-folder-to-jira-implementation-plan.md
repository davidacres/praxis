# Live Folder to Jira Migration Implementation Plan

## Problem Statement

Currently, the Live Folder to Jira migration command creates remote issues but leaves local markdown files intact, creating duplicates and confusion. We need a safe, user-controlled cleanup process that:

1. **Identifies work-item files by front matter** (not filename):
   - Files with `**Type:** Feature|Story|Task|Bug` = work items (migrate & cleanup)
   - Files without Type field = documentation (preserve)

2. **Prevents data loss**:
   - User must confirm migration to Jira was successful before cleanup
   - User explicitly opts into deletion (not automatic)
   - Option to skip deletion and clean up later

3. **Maintains audit trail**:
   - Record which local files were migrated to which Jira issues
   - Support re-runs without duplicates (idempotency)
   - Support rollback reference (local files as recovery point)

## Current State

- `Ticket Manager: Migrate Live Folder to Jira API` command exists but doesn't clean up
- Migration mapping not persisted (can't resume or prevent duplicates)
- No post-migration cleanup UI
- File identification is structural (folder layout) not semantic (front matter)

## Proposed Approach

### Phase 1: Work-Item File Classification

**Goal:** Reliably identify which local markdown files are work items vs documentation.

**Method:** Read front matter fields, not filename/path.

**Classification Logic:**
```typescript
function isWorkItemFile(content: string): { isWorkItem: boolean; type?: IssueType } {
  const typeRaw = extractTypeRaw(content);
  const normalized = normalizeChildIssueType(typeRaw);
  
  if (normalized && ['Feature', 'Story', 'Task', 'Bug'].includes(normalized)) {
    return { isWorkItem: true, type: normalized };
  }
  return { isWorkItem: false };
}
```

**Files to clean up:**
- Any markdown file in the Live Folder tree with `**Type: Feature|Story|Task|Bug**`
- Includes nested children (stories under features, tasks under stories, etc.)

**Files to preserve:**
- README.md, DESIGN.md, ARCHITECTURE.md
- Any file without a `Type` field in front matter
- Root folder metadata files

### Phase 2: Migration Mapping Storage

**Goal:** Record which local files were migrated to which Jira issues so we can:
- Resume partial migrations
- Prevent duplicate creates on retry
- Support cleanup with confidence

**Storage location:** Workspace state (ephemeral) + migration metadata file (optional)

**Mapping structure:**
```typescript
interface MigrationMapping {
  localFilePath: string;      // e.g., "features/feature-01-auth/story.md"
  localFileHash: string;      // SHA256 of content at migration time
  localIssueType: IssueType;  // Feature|Story|Task|Bug
  jiraProjectKey: string;     // PROJ
  jiraIssueKey: string;       // PROJ-123
  jiraIssueType: string;      // mapped target type
  createdAt: string;          // ISO timestamp
  migrationBatchId: string;   // UUID to group related migrations
}
```

**Persist to:**
- Workspace state: `ticketManager.liveFolderMigrationMappings` (fast resume)
- Optional sidecar file: `.vscode/live-folder-migrations.json` (audit trail, human-readable)

### Phase 3: Safe Migration Command Refactor

**Goal:** Enhance `migrateLiveFolderToJiraApi` to:
1. Discover and validate source files
2. Create mapping entries
3. Offer post-migration cleanup UI
4. Support dry-run before write

**Steps:**

#### 3a. Discovery & Validation
- Scan Live Folder tree
- Classify each file by front matter
- Count work items vs documentation
- Detect duplicates by local path
- Validate Type field is recognized

**Output:** Discovery report
```
Found 45 files:
  - 12 work items (8 Stories, 3 Tasks, 1 Bug)
  - 33 documentation files (README.md, guides, etc.)

Will migrate: 12 work items
Will preserve: 33 documentation files
```

#### 3b. Validation Before Migration
- Check Jira connectivity
- Check target epic/project exists
- Validate field mappings (priority, severity, etc.)
- Detect potential conflicts (existing issues with same key)
- Produce warnings for unsupported fields

**Output:** Validation report with go/no-go decision

#### 3c. Pre-Migration Dry Run
- Show all planned creates/updates
- No remote writes
- Show mapping summary
- Require user approval to proceed

#### 3d. Execute Migration
- Create remote issues via Jira API
- Record mappings in workspace state
- Update local files with Jira issue key (optional)
- Log progress per file
- Support retry on transient failures

**Output:** Migration results
```
✓ Created PROJ-123 from story-01.md
✓ Created PROJ-124 from story-02.md
✗ Failed to create issue from bug-03.md (Server error: timeout)
  → Mappings recorded. Safe to retry.
```

#### 3e. Post-Migration Cleanup Prompt
Only shown if migration succeeded for ≥1 file.

**Prompt:**
```
Migration to Jira successful! 12 work items created.

Local markdown files will NOT be deleted automatically for safety.

Your options:
a) Delete work-item files now (preserves documentation)
b) Delete work-item files + export mapping to .vscode/live-folder-migrations.json
c) Skip for now (can delete manually later)

🔒 Documentation files (README.md, etc.) are always preserved.
```

**User choices:**
- **Option A (recommended):** Delete work-item markdown, clear workspace state after success
- **Option B:** Delete + export mapping as JSON audit trail (allows rollback reference)
- **Option C:** Keep everything, no cleanup (can be done manually later)

#### 3f. Safe Deletion
- Only delete files identified by front matter (not filename)
- Verify file still has Type field before deleting
- Log each deletion
- Rollback on error (restore from workspace state record)

### Phase 4: UI Components

#### 4a. Migration Setup View Updates
Add to Setup view (when Live Folder + Jira API modes are active):

**Section: Live Folder → Jira Migration**
- Input: Select target epic or project
- Button: "Preview Migration"
- Button: "Start Migration"
- Help text linking to migration plan doc

#### 4b. Migration Progress Panel
Show during migration:
```
Migrating Live Folder to Jira (PROJ)...

⏳ Discovering files...
  Found 12 work items

⏳ Validating files...
  ✓ 12 files have valid Type field
  ⚠️ 3 files missing Priority (using default)

⏳ Creating issues...
  [████████░░] 8/12
  - story-01.md → PROJ-120
  - story-02.md → PROJ-121
  - story-03.md → PROJ-122
```

#### 4c. Cleanup Prompt (Modal Dialog)
```
✅ Migration Complete

12 work items successfully created in Jira.

Files ready for cleanup:
  - features/feature-01-auth/story-01.md → PROJ-120
  - features/feature-01-auth/story-02.md → PROJ-121
  - features/feature-02-api/story-01.md → PROJ-122
  ... (9 more files)

Documentation files will be preserved:
  - README.md
  - ARCHITECTURE.md
  - features/feature-01-auth/DESIGN.md

[A] Delete work items now  [B] Delete + Export mapping  [C] Skip for now
```

### Phase 5: Idempotency & Resume

**Goal:** Safe re-run without duplicate creates.

**Idempotency matching (in order):**
1. Check workspace state mappings for matching local file path
2. Check sidecar `.vscode/live-folder-migrations.json` if present
3. Look up local file content hash in Jira issue description (hidden metadata)
4. Fall back to title + parent match (with warning)

**Resume logic:**
- If partial migration failed, user can re-run
- Already-created issues skip without re-creating
- Failed items retry
- Successful items appear in report as "already migrated"

### Phase 6: Configuration Settings

Add to `package.json` settings:

```json
"ticketManager.liveFolderMigration.deleteWorkItemsAfterMigration": {
  "type": "boolean",
  "default": false,
  "description": "Automatically delete local work-item markdown files after successful Jira migration (not recommended without backup)"
},
"ticketManager.liveFolderMigration.exportMappingFile": {
  "type": "boolean",
  "default": true,
  "description": "Export migration mapping to .vscode/live-folder-migrations.json for audit trail"
},
"ticketManager.liveFolderMigration.preserveLocalCopies": {
  "type": "boolean",
  "default": true,
  "description": "Keep local markdown files after migration (recommended for rollback)"
}
```

## Implementation Order

1. **Phase 1** (foundation): File classification — enable all other phases
2. **Phase 2** (foundation): Mapping storage — enable idempotency
3. **Phase 3** (core): Command refactor — implement discovery, validation, cleanup
4. **Phase 4** (UX): UI components — make migration visible and safe
5. **Phase 5** (robustness): Idempotency — enable re-runs without duplicates
6. **Phase 6** (options): Settings — allow user preferences
7. **Testing**: Write tests for each phase

## Risk Mitigation

1. **Data Loss:** Workspace state + optional sidecar file ensure recovery paths exist
2. **Duplicate Creates:** Mapping-based idempotency prevents re-creates on retry
3. **Wrong Files Deleted:** Front matter classification ensures only work items are cleaned up
4. **Partial Failures:** Checkpoint after each successful issue, log everything
5. **User Confusion:** Clear UI, explicit prompts, help text linking to this plan

## Success Criteria

- ✅ Migration command discovers all work items in Live Folder
- ✅ No work items are created twice (idempotent)
- ✅ User explicitly opts into cleanup (not automatic)
- ✅ Only work-item files are deleted (doc files preserved)
- ✅ Mappings persist for audit trail
- ✅ Partial migrations can resume safely
- ✅ 95%+ test coverage for critical paths
- ✅ User sees progress and can recover from failures

## Related Documents

- [Live Folder Migration Goal](./live-folder-to-jira-gitlab-github.md) — High-level migration strategy
- [Live Folder mode guide](../user-guide.md#live-folder-mode) — Current markdown work-item structure and feature overview
