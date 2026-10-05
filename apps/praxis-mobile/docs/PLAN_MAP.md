# Mobile Plan Map

Deliver local work execution and release first: FX-BF-028, 029, 031, 032, 033. FX-BF-030 (account-free relay remote access and cloud notifications) is deferred. No running cloud service is required for the local milestone. IDs remain stable; FX-BE-086 owns the moved optional notification task TASK-232.

**Status reconciliation (2026-09-10, updated 2026-09-22).** The desktop half is
real and tested: the versioned execution boundary and dispatch, the host
lifecycle and access policy, the Noise `IK` secure transport
(`@praxis/mobile-protocol`, validated against the canonical `snow` vectors) and
a real LAN listener that authenticates and authorises each peer
(`mobileLanServer.ts`), plus the composed host bound to the live
session/workflow/project stores. FX-BF-028 stands.

As of 2026-09-22 the Expo SDK 57 app has production native adapters for TCP,
UDP discovery, camera QR scanning and protected key/config storage. It pairs
against the desktop's explicit confirmation flow, lists and restores scoped
sessions, creates/continues/cancels turns, consumes pushed transcript snapshots,
starts/cancels/retries workflows, and handles request-specific permissions and
workflow approvals. Demo data remains only for isolated fixtures. The remaining
closure gate is real iOS/Android development/release-build evidence across
pairing, foreground/background reconnect, revocation and interruption; no
physical-device evidence is claimed by this source change.

**Revision 2 (2026-09-23).** Provider/model/mode selection, real usage,
host-backed settings, token-gated pairing with explicit statuses, and
reconnect/replay are implemented and tested (see architecture.md). TASK-237/238
move to In Progress; physical-device journey evidence (TASK-241) is still owed.

**Open integration ownership (2026-09-22).** TASK-237–240 now have their source
paths wired end to end. TASK-241 remains the acceptance owner for production
binaries on physical iOS and Android devices. FX-BF-029/031–033 cannot close
from helper predicates, loopback fixtures, static screenshots, or Expo Go alone.

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| [FX-BE-074](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-074-versioned-execution-boundary/story.md) | Story | Versioned execution boundary | Complete | None |
| [FX-BE-075](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-075-host-lifecycle-and-access-enforcement/story.md) | Story | Host lifecycle and access enforcement | Complete | FX-BE-074 |
| [FX-BE-076](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-076-account-free-device-pairing/story.md) | Story | Account-free device pairing | In Progress | FX-BE-075 |
| [FX-BE-077](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-077-discovery-and-resilient-local-transport/story.md) | Story | Discovery and resilient local transport | In Progress | FX-BE-076 |
| [FX-BE-078](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-078-genericsystem-and-roleover-integration/story.md) | Story | GenericSystem and Roleover integration | Backlog | FX-BE-075 |
| [FX-BE-079](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-account-free-relay-and-remote-pairing/story.md) | Story | Account-free relay and remote pairing | In Progress | FX-BE-076, FX-BE-077 |
| [FX-BE-080](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-080-portable-mobile-application-foundation/story.md) | Story | Portable mobile application foundation | In Progress | FX-BE-074 |
| [FX-BE-081](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-081-read-and-continue-existing-work/story.md) | Story | Read and continue existing work | In Progress | FX-BE-080, FX-BE-077 |
| [FX-BE-082](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-082-start-and-control-existing-work/story.md) | Story | Start and control existing work | In Progress | FX-BE-081 |
| [FX-BE-083](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/story.md) | Story | Attention and request-specific approvals | In Progress | FX-BE-082 |
| [FX-BE-084](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-084-mobile-lifecycle-and-optional-notifications/story.md) | Story | Mobile lifecycle and optional notifications | In Progress | FX-BE-083 |
| [FX-BE-085](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-085-operational-release-and-repository-extraction/story.md) | Story | Operational release and repository extraction | In Progress | FX-BE-084 |
| [FX-BE-086](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-086-deferred-internet-notifications/story.md) | Story | Deferred internet notifications | Backlog | FX-BE-079, FX-BE-085 |
| [FX-BF-028](plans/features/fx-bf-028-execution-host-and-protocol/feature.md) | Feature | Execution host and mobile protocol | Complete | None |
| [FX-BF-029](plans/features/fx-bf-029-local-pairing-and-connectivity/feature.md) | Feature | Local pairing and direct connectivity | In Progress | FX-BE-075 |
| [FX-BF-030](plans/features/fx-bf-030-identity-and-azure-relay/feature.md) | Feature | Account-free remote access over a relay | In Progress | FX-BE-075 |
| [FX-BF-031](plans/features/fx-bf-031-mobile-shell-and-continuation/feature.md) | Feature | Mobile shell and work continuation | In Progress | FX-BE-074 |
| [FX-BF-032](plans/features/fx-bf-032-mobile-execution-and-decisions/feature.md) | Feature | Mobile workflow execution and decisions | In Progress | FX-BE-081 |
| [FX-BF-033](plans/features/fx-bf-033-mobile-reliability-and-release/feature.md) | Feature | Mobile reliability and release readiness | In Progress | FX-BE-083 |
| [TASK-201](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-074-versioned-execution-boundary/tasks/task-201-audit-execution-ownership-and-freeze-protocol-v1.md) | Task | Audit execution ownership and freeze protocol v1 | Complete | None |
| [TASK-202](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-074-versioned-execution-boundary/tasks/task-202-extract-shared-host-application-services.md) | Task | Extract shared host application services | Complete | TASK-201 |
| [TASK-203](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-074-versioned-execution-boundary/tasks/task-203-add-durable-commands-events-and-request-specific-decisions.md) | Task | Add durable commands events and request-specific decisions | Complete | TASK-202 |
| [TASK-204](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-075-host-lifecycle-and-access-enforcement/tasks/task-204-implement-off-local-only-and-internet-access-policy.md) | Task | Implement off local-only and internet access policy | Complete | FX-BE-074 |
| [TASK-205](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-075-host-lifecycle-and-access-enforcement/tasks/task-205-separate-client-connection-lifecycle-from-execution.md) | Task | Separate client connection lifecycle from execution | Complete | TASK-204 |
| [TASK-206](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-075-host-lifecycle-and-access-enforcement/tasks/task-206-add-access-settings-device-administration-and-audit.md) | Task | Add access settings device administration and audit | Complete | TASK-205 |
| [TASK-207](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-076-account-free-device-pairing/tasks/task-207-specify-and-implement-authenticated-pairing-handshake.md) | Task | Specify and implement authenticated pairing handshake | Complete | FX-BE-075 |
| [TASK-208](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-076-account-free-device-pairing/tasks/task-208-persist-and-revoke-device-trust-securely.md) | Task | Persist and revoke device trust securely | Complete | TASK-207 |
| [TASK-209](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-076-account-free-device-pairing/tasks/task-209-verify-local-pairing-user-journey.md) | Task | Verify local pairing user journey | Complete | TASK-208 |
| [TASK-210](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-077-discovery-and-resilient-local-transport/tasks/task-210-add-discovery-and-manual-host-resolution.md) | Task | Add discovery and manual host resolution | Complete | FX-BE-076 |
| [TASK-211](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-077-discovery-and-resilient-local-transport/tasks/task-211-implement-encrypted-direct-transport-and-reconnection.md) | Task | Implement encrypted direct transport and reconnection | Complete | TASK-210 |
| [TASK-212](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-077-discovery-and-resilient-local-transport/tasks/task-212-prove-lan-only-execution-without-cloud-dependencies.md) | Task | Prove LAN-only execution without cloud dependencies | Complete | TASK-211 |
| [TASK-213](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-078-genericsystem-and-roleover-integration/tasks/task-213-audit-identity-and-resource-authorisation-capabilities.md) | Task | Audit identity and resource authorisation capabilities | Backlog | FX-BE-075 |
| [TASK-214](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-078-genericsystem-and-roleover-integration/tasks/task-214-implement-optional-desktop-and-required-internet-sign-in.md) | Task | Implement optional desktop and required internet sign-in | Backlog | TASK-213 |
| [TASK-215](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-078-genericsystem-and-roleover-integration/tasks/task-215-enforce-scoped-roles-revocation-and-sign-out.md) | Task | Enforce scoped roles revocation and sign-out | Backlog | TASK-214 |
| [TASK-216](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-account-free-relay-and-remote-pairing/tasks/task-216-spike-relay-hosting-and-flutter-websocket-transport.md) | Task | Spike relay hosting and Flutter WebSocket transport | Backlog | FX-BE-076, FX-BE-077 |
| [TASK-217](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-account-free-relay-and-remote-pairing/tasks/task-217-implement-account-free-byte-relay-with-per-host-quotas.md) | Task | Implement the account-free byte relay with per-host quotas | Complete | TASK-216 |
| [TASK-218](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-account-free-relay-and-remote-pairing/tasks/task-218-secure-end-to-end-relay-traffic-and-route-changes.md) | Task | Prove secure end-to-end relay traffic and route changes | Backlog | TASK-390, TASK-391 |
| [TASK-219](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-080-portable-mobile-application-foundation/tasks/task-219-select-mobile-packaging-and-establish-build-boundaries.md) | Task | Select mobile packaging and establish build boundaries | Complete | FX-BE-074 |
| [TASK-220](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-080-portable-mobile-application-foundation/tasks/task-220-build-praxis-mobile-navigation-and-shared-appearance.md) | Task | Build Praxis mobile navigation and shared appearance | Complete | TASK-219 |
| [TASK-221](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-080-portable-mobile-application-foundation/tasks/task-221-add-mock-host-and-isolated-mobile-ci.md) | Task | Add mock host and isolated mobile CI | Complete | TASK-220 |
| [TASK-222](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-081-read-and-continue-existing-work/tasks/task-222-implement-work-list-and-session-restoration.md) | Task | Implement work list and session restoration | Complete | FX-BE-080, FX-BE-077 |
| [TASK-223](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-081-read-and-continue-existing-work/tasks/task-223-implement-conversation-follow-ups-and-result-review.md) | Task | Implement conversation follow-ups and result review | Complete | TASK-222 |
| [TASK-224](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-081-read-and-continue-existing-work/tasks/task-224-verify-complete-lan-continuation-milestone.md) | Task | Verify complete LAN continuation milestone | Complete | TASK-223 |
| [TASK-225](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-082-start-and-control-existing-work/tasks/task-225-expose-runnable-existing-workflow-and-agent-choices.md) | Task | Expose runnable existing workflow and agent choices | Complete | FX-BE-081 |
| [TASK-226](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-082-start-and-control-existing-work/tasks/task-226-implement-start-retry-and-cancellation-actions.md) | Task | Implement start retry and cancellation actions | Complete | TASK-225 |
| [TASK-227](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-082-start-and-control-existing-work/tasks/task-227-verify-desktop-and-mobile-execution-parity.md) | Task | Verify desktop and mobile execution parity | Complete | TASK-226 |
| [TASK-228](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/tasks/task-228-build-actionable-attention-inbox.md) | Task | Build actionable attention inbox | Complete | FX-BE-082 |
| [TASK-229](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/tasks/task-229-implement-scoped-decision-commands.md) | Task | Implement scoped decision commands | Complete | TASK-228 |
| [TASK-230](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/tasks/task-230-verify-full-internet-execution-milestone.md) | Task | Verify full local execution milestone | Complete | TASK-229 |
| [TASK-231](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-084-mobile-lifecycle-and-optional-notifications/tasks/task-231-harden-suspension-reconnect-and-local-data-handling.md) | Task | Harden suspension reconnect and local data handling | Complete | FX-BE-083 |
| [TASK-232](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-086-deferred-internet-notifications/tasks/task-232-add-opt-in-attention-notifications.md) | Task | Add opt-in attention notifications | Backlog | FX-BE-079, FX-BE-085 |
| [TASK-233](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-084-mobile-lifecycle-and-optional-notifications/tasks/task-233-verify-interruption-and-accessibility-matrix.md) | Task | Verify interruption and accessibility matrix | Complete | TASK-231 |
| [TASK-234](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-085-operational-release-and-repository-extraction/tasks/task-234-prepare-release-operations-and-rollback.md) | Task | Prepare release operations and rollback | Complete | FX-BE-084 |
| [TASK-235](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-085-operational-release-and-repository-extraction/tasks/task-235-prove-standalone-repository-portability.md) | Task | Prove standalone repository portability | Complete | TASK-234 |
| [TASK-236](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-085-operational-release-and-repository-extraction/tasks/task-236-complete-release-acceptance-and-documentation.md) | Task | Complete release acceptance and documentation | Complete | TASK-235 |
| [TASK-237](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-077-discovery-and-resilient-local-transport/tasks/task-237-connect-native-mobile-client-to-desktop-host.md) | Task | Connect native mobile client to desktop host | In Progress | TASK-212 |
| [TASK-238](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-081-read-and-continue-existing-work/tasks/task-238-wire-mobile-sessions-to-live-host-data.md) | Task | Wire mobile sessions to live host data | In Progress | TASK-237 |
| [TASK-239](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-082-start-and-control-existing-work/tasks/task-239-enable-live-workflow-execution-commands.md) | Task | Enable live workflow execution commands | Planned | TASK-238 |
| [TASK-240](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/tasks/task-240-enable-request-scoped-mobile-decisions.md) | Task | Enable request-scoped mobile decisions | Planned | TASK-239 |
| [TASK-241](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/tasks/task-241-prove-live-mobile-desktop-journey.md) | Task | Prove live mobile-desktop journey | Planned | TASK-237, TASK-238, TASK-239, TASK-240 |
| [TASK-389](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-account-free-relay-and-remote-pairing/tasks/task-389-extend-qr-pairing-with-relay-route-and-host-channel.md) | Task | Extend QR pairing with a relay route and host channel | In Progress | TASK-216, TASK-207 |
| [TASK-390](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-account-free-relay-and-remote-pairing/tasks/task-390-add-desktop-outbound-relay-listener.md) | Task | Add the desktop outbound relay listener | In Progress | TASK-217, TASK-389 |
| [TASK-391](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-account-free-relay-and-remote-pairing/tasks/task-391-add-flutter-relay-transport-and-route-selection.md) | Task | Add the Flutter relay transport and route selection | In Progress | TASK-217, TASK-389 |

## Multiple desktop connections (2026-10-05)

Priority and stage policy, dependencies, agent recommendations and validation are defined in the feature. All new items are Backlog.

| Ref | Type | Name | Priority | Delivery | Depends on |
| --- | --- | --- | --- | --- | --- |
| [FX-BF-108](plans/features/fx-bf-108-multiple-desktop-connections/feature.md) | Feature | Multiple desktop connections | High | All stages | FX-BE-076, FX-BE-077, FX-BE-080, FX-BE-081, FX-BE-083 |
| [FX-BE-161](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-161-saved-desktop-registry/story.md) | Story | Saved desktop registry and migration | High | First release | None |
| [TASK-420](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-161-saved-desktop-registry/tasks/task-420.md) | Task | Define registry and identity contracts | High | First release | None |
| [TASK-421](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-161-saved-desktop-registry/tasks/task-421.md) | Task | Implement recoverable secure-storage migration | High | First release | TASK-420 |
| [FX-BE-162](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-162-safe-desktop-switching/story.md) | Story | Safe desktop switching and reconnection | High | First release | FX-BE-161 |
| [TASK-422](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-162-safe-desktop-switching/tasks/task-422.md) | Task | Implement guarded connection transitions | High | First release | FX-BE-161 |
| [TASK-423](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-162-safe-desktop-switching/tasks/task-423.md) | Task | Verify startup reconnect and stale-response isolation | High | First release | TASK-422 |
| [FX-BE-163](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-163-desktop-picker-and-names/story.md) | Story | Desktop picker and connection naming | High | First release | FX-BE-161, FX-BE-162 |
| [TASK-424](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-163-desktop-picker-and-names/tasks/task-424.md) | Task | Build picker and naming controls | High | First release | FX-BE-161 |
| [TASK-425](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-163-desktop-picker-and-names/tasks/task-425.md) | Task | Integrate picker and visually verify layouts | High | First release | TASK-424, FX-BE-162 |
| [FX-BE-164](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-164-add-repair-forget-desktops/story.md) | Story | Add repair and forget desktop pairings | High | First release | FX-BE-161, FX-BE-162, FX-BE-163 |
| [TASK-426](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-164-add-repair-forget-desktops/tasks/task-426.md) | Task | Make pairing additive and identity-aware | High | First release | FX-BE-161, FX-BE-162 |
| [TASK-427](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-164-add-repair-forget-desktops/tasks/task-427.md) | Task | Add scoped repair and forget flows | High | First release | TASK-426, FX-BE-163 |
| [FX-BE-165](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-165-desktop-scoped-drafts-and-preferences/story.md) | Story | Desktop-scoped drafts projects and appearance | High | First release | FX-BE-161, FX-BE-162 |
| [TASK-428](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-165-desktop-scoped-drafts-and-preferences/tasks/task-428.md) | Task | Implement host-scoped preference and draft storage | High | First release | FX-BE-161 |
| [TASK-429](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-165-desktop-scoped-drafts-and-preferences/tasks/task-429.md) | Task | Restore scoped state and verify pending actions | High | First release | TASK-428, FX-BE-162 |
| [FX-BE-166](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-166-first-release-qualification/story.md) | Story | First release qualification and visual evidence | High | First release | FX-BE-162, FX-BE-163, FX-BE-164, FX-BE-165 |
| [TASK-430](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-166-first-release-qualification/tasks/task-430.md) | Task | Build two-host adversarial integration harness | High | First release | FX-BE-161, FX-BE-162 |
| [TASK-431](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-166-first-release-qualification/tasks/task-431.md) | Task | Capture end-to-end visual and device evidence | High | First release | TASK-430, FX-BE-163, FX-BE-164, FX-BE-165 |
| [TASK-432](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-166-first-release-qualification/tasks/task-432.md) | Task | Qualify release builds and document behaviour | High | First release | TASK-431 |
| [FX-BE-167](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-167-concurrent-desktop-observation/story.md) | Story | Concurrent desktop observation and lifecycle | Medium | Later stage 2 | FX-BE-166 |
| [TASK-433](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-167-concurrent-desktop-observation/tasks/task-433.md) | Task | Design per-host contexts and resource budgets | Medium | Later stage 2 | FX-BE-166 |
| [TASK-434](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-167-concurrent-desktop-observation/tasks/task-434.md) | Task | Implement and qualify concurrent observation | Medium | Later stage 2 | TASK-433 |
| [FX-BE-168](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-168-combined-attention-and-activity/story.md) | Story | Combined attention and activity across desktops | Medium | Later stage 2 | FX-BE-167 |
| [TASK-435](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-168-combined-attention-and-activity/tasks/task-435.md) | Task | Implement aggregate projections and host routing | Medium | Later stage 2 | FX-BE-167 |
| [TASK-436](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-168-combined-attention-and-activity/tasks/task-436.md) | Task | Verify aggregate actions and visual layouts | Medium | Later stage 2 | TASK-435 |
| [FX-BE-169](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-169-multi-desktop-notifications/story.md) | Story | Host-scoped notifications and deep links | Low | Later stage 3 | FX-BE-168, FX-BE-086 |
| [TASK-437](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-169-multi-desktop-notifications/tasks/task-437.md) | Task | Specify notification ownership and deep-link contract | Low | Later stage 3 | FX-BE-168, FX-BE-086 |
| [TASK-438](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-169-multi-desktop-notifications/tasks/task-438.md) | Task | Implement per-host preferences and safe click routing | Low | Later stage 3 | TASK-437 |
| [TASK-439](plans/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-169-multi-desktop-notifications/tasks/task-439.md) | Task | Qualify notifications and final feature closure | Low | Later stage 3 | TASK-438 |
