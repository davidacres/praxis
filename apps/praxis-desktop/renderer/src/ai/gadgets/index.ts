/**
 * The renderer's gadget module.
 *
 * Importing this registers every built-in renderer, so a consumer only needs
 * `GadgetBlockList` (or `GadgetSurface`) and nothing else.
 */
import { registerBuiltInGadgetRenderers } from './renderers';

registerBuiltInGadgetRenderers();

export { GadgetSurface, GadgetBlockList } from './GadgetSurface';
export { ToolCompletionGadget, groupToolCompletions } from './ToolCompletionGadget';
export { BUILT_IN_GADGET_CATALOG } from './gadgetCatalog';
export type { GadgetCatalogEntry } from './gadgetCatalog';
export { GadgetFallback, registerGadgetRenderer, resolveGadgetRenderer, registeredGadgetKinds, clearGadgetRenderers } from './registry';
export { GADGET_CONTRACT_VERSION, describeInertState, isGadgetActionable } from './gadgetContract';
export type { GadgetRenderer, GadgetRendererProps } from './gadgetContract';
