# Published artifacts, archived

Standalone copies of every artifact published to claude.ai for this project, so
they survive independent of a chat session or the artifact host. Each is the
page's authored content (title, styles, markup) wrapped in a minimal HTML
document — the artifact platform's own runtime script is stripped, since it
only functions on claude.ai and isn't part of the authored content. Open any
file directly in a browser to view it.

These are point-in-time design docs, UI audits, and onboarding walkthroughs —
narrative artifacts, not specs this app reads at runtime. Content is not kept
in sync automatically; if one goes stale, fix it here and republish by hand.

On 23 Sep 2026 every page gained a "Where it stands now" section of real
screenshots from the current build. The images live in `shots/` beside the
pages and are referenced relatively, so keep the folder with them. The
"Praxis Mobile screens" canvas (a Design-type artifact on claude.ai) is not
archived as a page; its screenshots are the `shots/m-*.jpg` and
`shots/mobile-*.jpg` files.

| File | Was published as | Subject |
| --- | --- | --- |
| `handing-a-ticket-to-an-agent.html` | Handing a Ticket to an Agent | Verifies the ticket-to-agent flow works, what's proven vs. not |
| `the-first-ten-minutes.html` | The First Ten Minutes | Onboarding funnel audit — 7 of 9 findings shipped |
| `your-first-praxis-project.html` | Your First Praxis Project | New-user walkthrough of workspace → project → board → session |
| `praxis-fast-paths.html` | Praxis Fast Paths | The short version for people who already know what they want |
| `praxis-interface-audit.html` | Praxis Interface Audit | Ten UI findings from a pass over the shipped interface — all shipped |
| `praxis-interface-system.html` | Praxis Interface System | Reference: the tokens, scales and patterns `theme.css` defines |
| `multi-corner-motif.html` | Multi-Corner Motif | Changelog: the corner-motif picker becomes a 2×2 toggle |
| `praxis-sidebar-theming.html` | Praxis Sidebar Theming | Design proposal (not built) — an independently themed sidebar |
| `sidebar-surface-parity.html` | Sidebar Surface Parity | Changelog: fixing a surface pack rendering flat on the sidebar |
| `project-details-and-board-surface.html` | Project Details & Board Surface | FX-BF-008 changelog — project inspector and plain-background boards |
| `praxis-surface-packs.html` | Praxis Surface Packs | Implementation plan for the surface-pack material layer |
| `praxis-surfaces.html` | Praxis Surfaces | Reference: the six shipped surface packs, rendered live from the CSS |
| `praxis-on-your-phone.html` | Praxis on Your Phone | The mobile app: pairing, attention, sessions and settings, from the iOS simulator |
| `praxis.html` | Praxis | Product landing page: ACP orchestration, SDLC suite, memory, ADRs, status |
| `praxis-code-intelligence.html` | Praxis Code Intelligence | Reference: the local code index, hybrid search ranking, the eleven agent tools |
| `code-intelligence-semantic-search-experiments.md` | Praxis code intelligence: semantic search experiments and results (Oct 2026) | Benchmark write-up behind search plan 8 and unset-mode routing |
| `shelf-create-designs.html` | Shelf Create Designs | Five designs for starting a note or session from the collapsed-sidebar shelf |
| `shelf-create-iterations.html` | Shelf Create Iterations | Ten iterations refining the shelf's create actions |
| `shelf-spine-designs.html` | Shelf Spine Designs | Ten ways for shelf spines to show session state |

## Synced 7 Nov 2026

The last six rows of the table were added. Notes:

- `praxis-code-intelligence.html` renders its Mermaid diagram with the same
  build the artifact host used (11.16.1), loaded from jsdelivr instead of the
  host's `/_runtime/` path.
- `shelf-spine-designs.html`'s three captures are `shots/spines-*.png`.
- `code-intelligence-semantic-search-experiments.md` is a Claude Docs document
  exported to Markdown; its relative paths point into
  `apps/praxis-desktop/docs/evaluations/code-intelligence/`.
- `praxis-fast-paths.html` is intentionally *not* overwritten: the repo copy
  carries a three-line CSS fix the published page lacks.

Not archived, because they are typed artifacts (slide deck / design canvas)
that only render inside claude.ai's own runtime: **Praxis — Status Overview**
(deck), **Scheduled Runs — 5 Directions**, **AI Provider Catalog** and
**Praxis Mobile screens** (canvases). Two further typed artifacts, **Slides**
and **Design**, are empty.
