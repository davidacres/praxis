import type { AgentToolMode } from '@praxis/core';

/**
 * What the Virtual Team may do on this turn, spelled out for the model. The
 * personas' base prompt says they can only advise and propose, and proposed
 * actions are read-only text in the transcript, so without this note a persona
 * with real tools still just advises and never asks whether to proceed.
 */
export function assistantCapabilityNote(input: { toolMode: AgentToolMode | undefined; mode: 'chat' | 'analysis' | 'review'; workingDirectory?: string }): string {
  const toolMode = input.mode === 'chat' ? input.toolMode : 'read-only';
  const noFooter = 'Do not add a praxis-assistant "action" footer: it cannot be applied from this chat.';
  if (toolMode === 'full') {
    return [
      `Capability for this turn: you HAVE working tools in ${input.workingDirectory ?? 'the selected folder'} (file edits and commands; the user approves sensitive steps). The rule above that you can only advise does not apply to this turn.`,
      'When the user asks for something, or the next step is clearly within what they asked, DO it with your tools, then report what you changed and how you checked it.',
      'If the request is ambiguous, risky, or beyond what was asked, do not guess: end your reply with one direct question asking whether to proceed, and wait for the answer.',
      noFooter
    ].join('\n');
  }
  if (toolMode === 'read-only') {
    return [
      'Capability for this turn: you have READ-ONLY tools. Inspect files and gather facts, but do not change anything.',
      'If a change is warranted, describe it and end your reply with one direct question asking whether the user wants you to proceed; tell them to switch to Chat mode with Full tools so you can do it.',
      noFooter
    ].join('\n');
  }
  return [
    'Capability for this turn: you have no tools and cannot apply changes from this chat.',
    'If a change is warranted, describe it and end your reply with one direct question asking whether the user wants you to proceed; tell them to enable Full tools and a working folder so you can do it.',
    noFooter
  ].join('\n');
}
