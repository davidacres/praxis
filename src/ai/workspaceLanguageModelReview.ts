import * as vscode from 'vscode';
import type { IssueDetails } from '../types';
import { AnalysisCancelledError, buildTicketContext, type ReviewStreamOptions } from './aiReviewService';

const DEFAULT_REVIEW_SYSTEM_PROMPT = `You are a senior software engineer analysing a development ticket and any code/context provided.
Explain the problem, determine a safe solution, and show the code-level changes required.
If acceptance criteria are missing, propose clear, testable acceptance criteria.
Use plain text with headings and bullet points only. Do not use tables or HTML.`;

export interface WorkspaceLanguageModelOption {
  id: string;
  label: string;
}

export async function listWorkspaceLanguageModelOptions(): Promise<WorkspaceLanguageModelOption[]> {
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    return [];
  }

  const models = await vscode.lm.selectChatModels({});
  const seen = new Set<string>();
  const options: WorkspaceLanguageModelOption[] = [];
  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push({ id, label: model.name?.trim() || id });
  }
  return options;
}

async function resolveWorkspaceLanguageModel(modelId?: string): Promise<vscode.LanguageModelChat> {
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    throw new Error('This editor does not expose language models for analysis. Use OpenAI, Claude, or GitHub Copilot SDK instead.');
  }

  const selector = modelId?.trim() ? { id: modelId.trim() } : {};
  const models = await vscode.lm.selectChatModels(selector);
  if (models.length === 0) {
    throw new Error(
      modelId?.trim()
        ? `Language model '${modelId.trim()}' is not available in this editor.`
        : 'No language models are available in this editor. Sign in to Cursor AI or choose a different provider in Configure AI.'
    );
  }
  return models[0];
}

export async function reviewTicketWithWorkspaceLanguageModel(
  issue: IssueDetails,
  agentName: string,
  options?: ReviewStreamOptions
): Promise<string> {
  const model = await resolveWorkspaceLanguageModel(options?.model);
  const ticketContext = buildTicketContext(issue);
  const systemPrompt = options?.systemPrompt?.trim() || DEFAULT_REVIEW_SYSTEM_PROMPT;
  const userMessage = `${systemPrompt}\n\nPlease analyse this ticket:\n\n${ticketContext}`;

  const cancellation = new vscode.CancellationTokenSource();
  const abortListener = (): void => cancellation.cancel();
  options?.signal?.addEventListener('abort', abortListener);

  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(userMessage)],
      {},
      cancellation.token
    );

    let content = '';
    for await (const chunk of response.text) {
      if (options?.signal?.aborted) {
        throw new AnalysisCancelledError();
      }
      if (!chunk) {
        continue;
      }
      content += chunk;
      options?.onUpdate?.(`## AI Review by ${agentName}\n\n${content}`);
    }

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('The editor language model returned an empty response.');
    }

    return `## AI Review by ${agentName}\n\n${trimmed}`;
  } finally {
    options?.signal?.removeEventListener('abort', abortListener);
    cancellation.dispose();
  }
}
