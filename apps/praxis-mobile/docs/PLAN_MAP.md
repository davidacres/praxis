# Mobile Plan Map

Deliver local work execution and release first: FX-BF-028, 029, 031, 032, 033. FX-BF-030 (identity, Azure and cloud notifications) is deferred. No running cloud service is required for the local milestone. IDs remain stable; FX-BE-086 owns the moved optional notification task TASK-232.

**Status reconciliation (2026-09-10, updated 2026-09-22).** The desktop half is
real and tested: the versioned execution boundary and dispatch, the host
lifecycle and access policy, the Noise `IK` secure transport
(`@praxis/mobile-protocol`, validated against the canonical `snow` vectors) and
a real LAN listener that authenticates and authorises each peer
(`mobileLanServer.ts`), plus the composed host bound to the live
session/workflow/project stores. FX-BF-028 stands.

As of 2026-09-12 there **is** a React Native app (`apps/praxis-mobile`, Expo
SDK 57) — it builds, boots in `expo start --ios`, and renders (verified in the
iOS Simulator: Connect → Work list → Work detail with Chat/Progress/Changes →
Attention, screenshotted). It runs against **canned demo data only**
(`app/demoData.ts`); it does not yet open a real socket to a desktop host. So
FX-BF-029/031–033 stay In Progress, not because nothing runs but because the
runnable app doesn't yet talk to the runnable host. See "Resume here" in
[development.md](development.md#resume-here-2026-09-12) for the exact next
steps. `sessions.continue` / `permissions.respond` / `workflowRuns.start`
remain explicit `MobileHostPendingError`s pending the permission FIFO →
request-id rework (architecture.md) and FX-BE-082. TASK-237 through TASK-241
now explicitly own the native connection, live session data, host commands,
request-scoped decisions, and physical-device integration proof; completed
helper-level tasks remain historical records rather than evidence that this gap
is closed.

| Ref | Type | Name | Status | Depends on |
| --- | --- | --- | --- | --- |
| [FX-BE-074](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-074-versioned-execution-boundary/story.md) | Story | Versioned execution boundary | Complete | None |
| [FX-BE-075](plans/features/fx-bf-028-execution-host-and-protocol/stories/fx-be-075-host-lifecycle-and-access-enforcement/story.md) | Story | Host lifecycle and access enforcement | Complete | FX-BE-074 |
| [FX-BE-076](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-076-account-free-device-pairing/story.md) | Story | Account-free device pairing | In Progress | FX-BE-075 |
| [FX-BE-077](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-077-discovery-and-resilient-local-transport/story.md) | Story | Discovery and resilient local transport | In Progress | FX-BE-076 |
| [FX-BE-078](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-078-genericsystem-and-roleover-integration/story.md) | Story | GenericSystem and Roleover integration | Backlog | FX-BE-075 |
| [FX-BE-079](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-azure-relay-and-host-registration-service/story.md) | Story | Azure Relay and host registration service | Backlog | FX-BE-078, FX-BE-076 |
| [FX-BE-080](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-080-portable-mobile-application-foundation/story.md) | Story | Portable mobile application foundation | In Progress | FX-BE-074 |
| [FX-BE-081](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-081-read-and-continue-existing-work/story.md) | Story | Read and continue existing work | In Progress | FX-BE-080, FX-BE-077 |
| [FX-BE-082](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-082-start-and-control-existing-work/story.md) | Story | Start and control existing work | In Progress | FX-BE-081 |
| [FX-BE-083](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/story.md) | Story | Attention and request-specific approvals | In Progress | FX-BE-082 |
| [FX-BE-084](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-084-mobile-lifecycle-and-optional-notifications/story.md) | Story | Mobile lifecycle and optional notifications | In Progress | FX-BE-083 |
| [FX-BE-085](plans/features/fx-bf-033-mobile-reliability-and-release/stories/fx-be-085-operational-release-and-repository-extraction/story.md) | Story | Operational release and repository extraction | In Progress | FX-BE-084 |
| [FX-BE-086](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-086-deferred-internet-notifications/story.md) | Story | Deferred internet notifications | Backlog | FX-BE-079, FX-BE-085 |
| [FX-BF-028](plans/features/fx-bf-028-execution-host-and-protocol/feature.md) | Feature | Execution host and mobile protocol | Complete | None |
| [FX-BF-029](plans/features/fx-bf-029-local-pairing-and-connectivity/feature.md) | Feature | Local pairing and direct connectivity | In Progress | FX-BE-075 |
| [FX-BF-030](plans/features/fx-bf-030-identity-and-azure-relay/feature.md) | Feature | Optional identity and Azure internet access | Backlog | FX-BE-075 |
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
| [TASK-216](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-azure-relay-and-host-registration-service/tasks/task-216-prototype-azure-relay-compatibility-and-cost.md) | Task | Prototype Azure Relay compatibility and cost | Backlog | FX-BE-078, FX-BE-076 |
| [TASK-217](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-azure-relay-and-host-registration-service/tasks/task-217-implement-host-registry-and-scoped-relay-credentials.md) | Task | Implement host registry and scoped relay credentials | Backlog | TASK-216 |
| [TASK-218](plans/features/fx-bf-030-identity-and-azure-relay/stories/fx-be-079-azure-relay-and-host-registration-service/tasks/task-218-secure-end-to-end-relay-traffic-and-route-changes.md) | Task | Secure end-to-end relay traffic and route changes | Backlog | TASK-217 |
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
| [TASK-237](plans/features/fx-bf-029-local-pairing-and-connectivity/stories/fx-be-077-discovery-and-resilient-local-transport/tasks/task-237-connect-native-mobile-client-to-desktop-host.md) | Task | Connect native mobile client to desktop host | Planned | TASK-212 |
| [TASK-238](plans/features/fx-bf-031-mobile-shell-and-continuation/stories/fx-be-081-read-and-continue-existing-work/tasks/task-238-wire-mobile-sessions-to-live-host-data.md) | Task | Wire mobile sessions to live host data | Planned | TASK-237 |
| [TASK-239](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-082-start-and-control-existing-work/tasks/task-239-enable-live-workflow-execution-commands.md) | Task | Enable live workflow execution commands | Planned | TASK-238 |
| [TASK-240](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/tasks/task-240-enable-request-scoped-mobile-decisions.md) | Task | Enable request-scoped mobile decisions | Planned | TASK-239 |
| [TASK-241](plans/features/fx-bf-032-mobile-execution-and-decisions/stories/fx-be-083-attention-and-request-specific-approvals/tasks/task-241-prove-live-mobile-desktop-journey.md) | Task | Prove live mobile-desktop journey | Planned | TASK-237, TASK-238, TASK-239, TASK-240 |
