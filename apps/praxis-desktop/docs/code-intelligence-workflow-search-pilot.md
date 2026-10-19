# Workflow code search retrieval pilot

Date: 2026-10-19

## Purpose

This exploratory comparison uses the same 30 natural-language workflow questions against `search_code` in lexical-only, semantic-only (vector), and hybrid modes. It measures whether one preselected target symbol appears in the first 10 results and its rank. It does not compare generated agent answers or compare with an agent that has no code-intelligence tool.

## Results

| Mode | Target in top 10 | Recall@10 | MRR@10 |
| --- | ---: | ---: | ---: |
| Lexical-only | 12/30 | 40.0% | 0.344 |
| Semantic-only (vector) | 12/30 | 40.0% | 0.237 |
| Hybrid | 15/30 | 50.0% | 0.373 |

Hybrid found three more target symbols than lexical-only and had a small MRR increase. Semantic-only found the same number as lexical-only but ranked them lower overall. Results vary by topic:

| Topic | Lexical-only | Semantic-only | Hybrid |
| --- | --- | --- | --- |
| Authoring (13) | 6/13 (46.2%), MRR 0.410 | 6/13 (46.2%), MRR 0.253 | 7/13 (53.8%), MRR 0.426 |
| Persistence (3) | 0/3 (0.0%), MRR 0.000 | 1/3 (33.3%), MRR 0.111 | 1/3 (33.3%), MRR 0.056 |
| Execution (10) | 4/10 (40.0%), MRR 0.350 | 2/10 (20.0%), MRR 0.150 | 4/10 (40.0%), MRR 0.350 |
| Outputs (4) | 2/4 (50.0%), MRR 0.375 | 3/4 (75.0%), MRR 0.500 | 3/4 (75.0%), MRR 0.500 |

## Question set and ranks

A rank of `miss` means the target did not appear in the top 10. Targets were selected before running the three modes. All 30 target symbols were confirmed to exist in the current index with `find_symbol`; their relevance labels were authored by the evaluator and have not had an independent review.

| ID | Topic | Question | Expected symbol | Lexical | Semantic | Hybrid |
| --- | --- | --- | --- | ---: | ---: | ---: |
| q01 | authoring | Where does the project workflow picker get its available workflow definitions? | `workflowIpc.projectDefinitions` | 1 | miss | 1 |
| q02 | authoring | Where are unsaved workflow drafts read back for a project? | `workflowIpc.draftDefinitions` | miss | miss | miss |
| q03 | authoring | How does the workflow library load globally installed templates? | `workflowIpc.globalTemplateDefinitions` | miss | 4 | miss |
| q04 | authoring | How does the app turn a project's workflows into choices shown to the user? | `workflowIpc.listWorkflowChoices` | miss | miss | miss |
| q05 | authoring | Where is the chosen workflow checked and converted into a runnable definition? | `workflowIpc.runnableDefinition` | 1 | 5 | 1 |
| q06 | authoring | How does the app find the folder associated with a project? | `workflowIpc.projectFolder` | miss | miss | miss |
| q07 | persistence | Where is an edited project workflow written to its permanent location? | `workflowIpc.persistProjectWorkflow` | miss | 3 | 6 |
| q08 | persistence | How are workflow changes saved locally before a project folder is available? | `workflowIpc.saveDraft` | miss | miss | miss |
| q09 | persistence | What removes a temporary workflow copy after the permanent file is saved? | `workflowIpc.dropDraft` | miss | miss | miss |
| q10 | execution | Where are workflow run inputs prepared and validated before launch? | `workflowIpc.prepareWorkflowRun` | miss | miss | miss |
| q11 | execution | Where is a new workflow run created and started? | `workflowIpc.startWorkflowRun` | miss | miss | miss |
| q12 | execution | Which function connects the workflow IPC handlers to the app? | `workflowIpc.registerWorkflowIpc` | miss | miss | miss |
| q13 | authoring | Which page loads and edits a selected workflow definition? | `WorkflowDesignerPage.WorkflowDesignerPage` | miss | miss | miss |
| q14 | authoring | Which helper changes the settings of one workflow node? | `workflowEdits.updateNode` | miss | miss | miss |
| q15 | authoring | How are two workflow stages connected with an edge? | `workflowEdits.connectNodes` | miss | 1 | 5 |
| q16 | authoring | How does the editor prevent an edge from creating a cycle? | `workflowEdits.wouldCloseCycle` | 1 | 2 | 1 |
| q17 | authoring | How does the editor arrange nodes into a readable graph layout? | `workflowEdits.autoArrange` | 1 | miss | 1 |
| q18 | authoring | How are workflow stages presented in dependency sequence? | `workflowTemplateGuidance.getWorkflowStageSequence` | 3 | 3 | 3 |
| q19 | authoring | How does the stage ordering handle joins that depend on longer branches? | `workflowTemplateGuidance.orderByDependencyLevel` | 1 | 1 | 1 |
| q20 | execution | How does the run page identify the currently active stage? | `WorkflowRunPage.activeStageOf` | 1 | 2 | 1 |
| q21 | execution | How are parallel stages grouped into pipeline levels for display? | `WorkflowPipelineVertical.pipelineLevels` | 1 | 1 | 1 |
| q22 | execution | What checks whether an agent stage has a usable provider before dispatch? | `workflowAgentStage.canDispatchAgentStage` | 2 | miss | 2 |
| q23 | execution | How is a stage's workflow instruction pack located for an agent run? | `workflowAgentStage.resolveStageWorkflowPack` | miss | miss | miss |
| q24 | execution | How is the originating issue and project context assembled for an agent stage? | `workflowAgentStage.resolveStageTicketContext` | 1 | miss | 1 |
| q25 | execution | Where does Praxis launch an agent stage and collect its final response? | `workflowAgentStage.runWorkflowAgentStage` | miss | miss | miss |
| q26 | execution | How does Praxis stop a running agent stage when a user cancels it? | `workflowAgentStage.cancelWorkflowAgentStage` | miss | miss | miss |
| q27 | outputs | When does a successful stage publish its declared board outputs? | `workflowAgentStage.publishPlanOutputs` | 1 | 2 | 1 |
| q28 | outputs | How does generated markdown become a feature and child items on the project board? | `workflowAgentStage.publishPlanToBoard` | miss | 2 | miss |
| q29 | outputs | How is a completed workflow run written back to the issue that started it? | `workflowOrchestratorInstance.writeBackToIssue` | miss | miss | 2 |
| q30 | outputs | How is the issue comment summarizing a workflow run formatted? | `workflowOrchestratorInstance.buildWriteBackComment` | 2 | 1 | 2 |

## Limits

- This is a 30-question, single-evaluator pilot from one workflow-heavy code area; it is not a blind or statistically conclusive benchmark.
- One target symbol per question makes this a narrow relevance metric; some questions may have several equally useful symbols.
- The code-intelligence index reported overall partial freshness during the run, although the active model had vectors for all 21,583 eligible symbols. The index was generation 78, query epoch 167.
- Some semantic-only result pages contained synthetic top-level entries. That ranking noise, along with partial freshness, should be resolved before treating this as a stable benchmark.
- The evaluation guide's release protocol is larger and requires reviewed labels and held-out acceptance queries. These results do not pass that protocol.

## How to read the metrics

Recall@10 is the share of questions whose target appeared in the first 10 results. MRR@10 is the mean reciprocal rank of the target (for example, rank 1 contributes 1.0; rank 4 contributes 0.25; a miss contributes 0).
