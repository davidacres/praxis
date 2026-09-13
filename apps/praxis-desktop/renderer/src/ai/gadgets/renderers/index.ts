/**
 * Registration of every built-in renderer.
 *
 * Importing this module is what populates the registry, so it must be imported
 * once for its side effect before any gadget is rendered — `gadgets/index.ts`
 * does that. Adding a kind means adding its renderer here; the registry itself
 * stays free of any knowledge of the individual surfaces.
 */
import { registerGadgetRenderer } from '../registry';
import { GADGET_CONTRACT_VERSION } from '../gadgetContract';
import { ChoiceGadget } from './ChoiceGadget';
import { ConfirmationGadget } from './ConfirmationGadget';
import { FormGadget } from './FormGadget';
import { TableGadget } from './TableGadget';
import { ChartGadget } from './ChartGadget';
import { ProgressGadget } from './ProgressGadget';
import { DiffGadget } from './DiffGadget';
import { ArtifactGadget } from './ArtifactGadget';
import { HandoffGadget } from './HandoffGadget';
import { ConflictGadget } from './ConflictGadget';
import { ApprovalGadget } from './ApprovalGadget';

export function registerBuiltInGadgetRenderers(): void {
  registerGadgetRenderer('choice', GADGET_CONTRACT_VERSION, ChoiceGadget);
  registerGadgetRenderer('confirmation', GADGET_CONTRACT_VERSION, ConfirmationGadget);
  registerGadgetRenderer('form', GADGET_CONTRACT_VERSION, FormGadget);
  registerGadgetRenderer('table', GADGET_CONTRACT_VERSION, TableGadget);
  registerGadgetRenderer('chart', GADGET_CONTRACT_VERSION, ChartGadget);
  registerGadgetRenderer('progress', GADGET_CONTRACT_VERSION, ProgressGadget);
  registerGadgetRenderer('diff', GADGET_CONTRACT_VERSION, DiffGadget);
  registerGadgetRenderer('artifact', GADGET_CONTRACT_VERSION, ArtifactGadget);
  registerGadgetRenderer('handoff', GADGET_CONTRACT_VERSION, HandoffGadget);
  registerGadgetRenderer('conflict', GADGET_CONTRACT_VERSION, ConflictGadget);
  registerGadgetRenderer('approval', GADGET_CONTRACT_VERSION, ApprovalGadget);
}

export {
  ChoiceGadget,
  ConfirmationGadget,
  FormGadget,
  TableGadget,
  ChartGadget,
  ProgressGadget,
  DiffGadget,
  ArtifactGadget,
  HandoffGadget,
  ConflictGadget,
  ApprovalGadget
};
