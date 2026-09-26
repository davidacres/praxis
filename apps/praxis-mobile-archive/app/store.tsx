/**
 * The phone's state and the actions on it. Split by concern under `store/`:
 * `StoreProvider` owns the connection lifecycle and state, `actions` the reads
 * and commands a screen calls, `projections` the pure shaping of host data, and
 * `types` the shapes screens consume. Screens import from here.
 */
export { MOBILE_PRIMARY_ROUTES } from '../renderer/mobileNavigation';
export type { MobileDetailTab, MobilePrimaryRoute } from '../renderer/mobileNavigation';
export { StoreProvider, useOpenAttention, useStore } from './store/StoreProvider';
export type {
  MobileActivityEntry,
  MobileHostSummary,
  MobileProjectSummary,
  MobileRunSummary,
  MobileTranscriptMessage,
  MobileWorkflowChoice,
  MobileWorkItem,
  Remote,
} from './store/types';
