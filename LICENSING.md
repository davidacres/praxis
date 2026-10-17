# Licensing

An engineering inventory of what Praxis is licensed under and what third-party
software and models it ships or downloads. It records decisions and obligations
as the project understands them; it is not legal advice.

## Praxis

Praxis is released under the **MIT License** — see [`LICENSE`](LICENSE). That
covers everything in this repository: the desktop app, the shared core, the
code-intelligence service and the phone app.

## The semantic search model

Code intelligence's semantic search uses one pinned embedding model. Users
cannot choose a different one: the service accepts only this exact model,
revision and checksum.

| | |
| --- | --- |
| Model | [`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) |
| Licence | **MIT**, as declared on the model card (the repository has no separate LICENSE file) |
| Revision | `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a` |
| Files | `onnx/model.onnx` (SHA-256 `828e1496…40cf35`, 133,093,490 bytes), `vocab.txt` (SHA-256 `07eced37…2038a3`) |
| Delivery | Downloaded on demand from Hugging Face by the desktop app, size- and checksum-verified. **Not bundled in the installer.** |
| Pinned in | `services/code-intelligence/models/bge-small-manifest.json`, `LocalModel.cs`, `semanticModelManager.ts` |

**Obligations.** MIT asks that the copyright and licence notice accompany copies
of the software. While Praxis downloads the model from its publisher, Praxis is
not distributing a copy. **If the model is ever bundled in the installer or
served from a Praxis-controlled mirror, include its MIT notice** alongside the
other third-party notices.

**MIT versus Apache-2.0.** The previous model,
`sentence-transformers/all-MiniLM-L6-v2` (used until 2026-10-17 and still named
in historical evaluation reports), was Apache-2.0. Both are permissive, allow
commercial use and are compatible with Praxis's MIT licence. The one material
difference is that Apache-2.0 includes an explicit patent grant and MIT does
not; for an openly published embedding model run locally, that was judged an
acceptable risk.

**Policy for any future model.**

- Only permissive licences: MIT, Apache-2.0 or BSD. Never non-commercial
  (`CC-BY-NC-*`) or research-only licences — several strong code-embedding
  models are excluded for exactly this reason.
- The licence is part of the pinned manifest and `LocalModel` checks it, so
  changing models means updating it deliberately, together with the golden test
  fixture (`scripts/generate-model-golden.py`) and this file.
- A model change is a release decision backed by the retrieval evaluation in
  `services/code-intelligence/docs/evaluations/`, not a setting.

## Third-party software

What reaches a user's machine:

- **Desktop installer** — the Electron runtime (which itself ships Chromium's
  and Node.js's notices in `LICENSES.chromium.html`), the main process's
  production npm dependencies, the renderer bundle, and the code-intelligence
  service package.
- **Code-intelligence service package** — published self-contained, so it
  carries the .NET runtime (MIT), its NuGet dependencies, and a copy of
  TypeScript (Apache-2.0) for the TypeScript sidecar.
- **Phone app** — Flutter (BSD-3-Clause) and its runtime pub packages.

Build and test tooling (Vite, Playwright, `rolldown`, `lightningcss`, xUnit, …)
is used to make Praxis but does not ship, so it is not listed.

**Adding a dependency.** Run `npm run licenses` and commit the updated tables.
Anything not on the permissive list in `scripts/generate-licensing.mjs` is
listed under **Needs review**. Strong copyleft (GPL, AGPL) must not ship;
weak copyleft (LGPL, MPL-2.0) needs a decision recorded here first.
`npm run licenses:check` fails when the tables are stale; it reads the local
npm lockfile, NuGet cache and pub cache, so restore all three first.

<!-- licensing:generated:begin — run `npm run licenses`; do not edit by hand -->

Totals: 145 npm, 12 NuGet, 79 pub. By licence: MIT 137 · BSD-3-Clause 71 · ISC 10 · Apache-2.0 8 · BlueOak-1.0.0 5 · BSD-2-Clause 3 · PSF-2.0 1 · Python-2.0 1.

**Needs review:** nothing — every shipped package is on the permissive list.

### Desktop app — npm packages in the installer

Production dependencies of `@praxis/desktop-main`, `@praxis/core` and the mobile protocol/relay packages, plus everything bundled into the renderer.

| Package | Version | Licence |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.4.0 | Apache-2.0 |
| `@hono/node-server` | 2.1.1 | MIT |
| `@isaacs/fs-minipass` | 4.0.1 | ISC |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `@noble/ciphers` | 1.3.0 | MIT |
| `@noble/curves` | 1.9.7 | MIT |
| `@noble/hashes` | 1.8.0 | MIT |
| `@xterm/addon-fit` | 0.11.0 | MIT |
| `@xterm/addon-webgl` | 0.19.0 | MIT |
| `@xterm/xterm` | 6.0.0 | MIT |
| `accepts` | 2.0.0 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `argparse` | 2.0.1 | Python-2.0 |
| `argparse` | 3.0.1 | PSF-2.0 |
| `body-parser` | 2.3.0 | MIT |
| `buffer-crc32` | 1.0.0 | MIT |
| `builder-util-runtime` | 9.7.0 | MIT |
| `bytes` | 3.1.2 | MIT |
| `call-bind-apply-helpers` | 1.0.2 | MIT |
| `call-bound` | 1.0.4 | MIT |
| `chokidar` | 4.0.3 | MIT |
| `chownr` | 3.0.0 | BlueOak-1.0.0 |
| `content-disposition` | 1.1.0 | MIT |
| `content-type` | 1.0.5 | MIT |
| `content-type` | 2.1.0 | MIT |
| `cookie` | 0.7.2 | MIT |
| `cookie-signature` | 1.2.2 | MIT |
| `cors` | 2.8.6 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `debug` | 4.4.3 | MIT |
| `depd` | 2.0.0 | MIT |
| `dunder-proto` | 1.0.1 | MIT |
| `ee-first` | 1.1.1 | MIT |
| `electron-updater` | 6.8.9 | MIT |
| `encodeurl` | 2.0.0 | MIT |
| `entities` | 4.5.0 | BSD-2-Clause |
| `entities` | 8.0.0 | BSD-2-Clause |
| `es-define-property` | 1.0.1 | MIT |
| `es-errors` | 1.3.0 | MIT |
| `es-object-atoms` | 1.1.2 | MIT |
| `escape-html` | 1.0.3 | MIT |
| `etag` | 1.8.1 | MIT |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `express` | 5.2.1 | MIT |
| `express-rate-limit` | 8.7.0 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.8 | BSD-3-Clause |
| `finalhandler` | 2.1.1 | MIT |
| `forwarded` | 0.2.0 | MIT |
| `fresh` | 2.0.0 | MIT |
| `fs-extra` | 10.1.0 | MIT |
| `function-bind` | 1.1.2 | MIT |
| `get-intrinsic` | 1.3.0 | MIT |
| `get-proto` | 1.0.1 | MIT |
| `gopd` | 1.2.0 | MIT |
| `graceful-fs` | 4.2.11 | ISC |
| `has-symbols` | 1.1.0 | MIT |
| `hasown` | 2.0.4 | MIT |
| `hono` | 4.13.7 | MIT |
| `http-errors` | 2.0.1 | MIT |
| `iconv-lite` | 0.7.3 | MIT |
| `inherits` | 2.0.4 | ISC |
| `ip-address` | 10.7.2 | MIT |
| `ipaddr.js` | 1.9.1 | MIT |
| `is-promise` | 4.0.0 | MIT |
| `isexe` | 2.0.0 | ISC |
| `jose` | 6.2.12 | MIT |
| `js-tokens` | 4.0.0 | MIT |
| `js-yaml` | 4.3.2 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause |
| `jsonc-parser` | 3.3.1 | MIT |
| `jsonfile` | 6.2.1 | MIT |
| `lazy-val` | 1.0.5 | MIT |
| `linkify-it` | 5.0.2 | MIT |
| `linkify-it` | 6.1.0 | MIT |
| `lodash.escaperegexp` | 4.1.2 | MIT |
| `lodash.isequal` | 4.5.0 | MIT |
| `loose-envify` | 1.4.0 | MIT |
| `markdown-it` | 14.3.2 | MIT |
| `markdown-it` | 15.0.1 | MIT |
| `math-intrinsics` | 1.1.0 | MIT |
| `mdurl` | 2.1.0 | MIT |
| `media-typer` | 1.1.1 | MIT |
| `merge-descriptors` | 2.0.0 | MIT |
| `mime-db` | 1.54.0 | MIT |
| `mime-types` | 3.0.2 | MIT |
| `minipass` | 7.1.3 | BlueOak-1.0.0 |
| `minizlib` | 3.1.0 | MIT |
| `ms` | 2.1.3 | MIT |
| `negotiator` | 1.1.0 | MIT |
| `node-addon-api` | 7.1.1 | MIT |
| `node-pty` | 1.1.0 | MIT |
| `object-assign` | 4.1.1 | MIT |
| `object-inspect` | 1.13.4 | MIT |
| `on-finished` | 2.4.1 | MIT |
| `once` | 1.4.0 | ISC |
| `parseurl` | 1.3.3 | MIT |
| `path-key` | 3.1.1 | MIT |
| `path-to-regexp` | 8.4.2 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `proxy-addr` | 2.0.8 | MIT |
| `punycode.js` | 2.3.1 | MIT |
| `qs` | 6.16.0 | BSD-3-Clause |
| `range-parser` | 1.3.0 | MIT |
| `raw-body` | 3.0.2 | MIT |
| `react` | 18.3.1 | MIT |
| `react-dom` | 18.3.1 | MIT |
| `readdirp` | 4.1.2 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `router` | 2.2.0 | MIT |
| `safer-buffer` | 2.1.2 | MIT |
| `sax` | 1.6.1 | BlueOak-1.0.0 |
| `scheduler` | 0.23.2 | MIT |
| `semver` | 7.7.4 | ISC |
| `send` | 1.2.1 | MIT |
| `serve-static` | 2.2.1 | MIT |
| `setprototypeof` | 1.2.0 | ISC |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `side-channel` | 1.1.1 | MIT |
| `side-channel-list` | 1.0.1 | MIT |
| `side-channel-map` | 1.0.1 | MIT |
| `side-channel-weakmap` | 1.0.2 | MIT |
| `statuses` | 2.0.2 | MIT |
| `tar` | 7.5.22 | BlueOak-1.0.0 |
| `tiny-typed-emitter` | 2.1.0 | MIT |
| `toidentifier` | 1.0.1 | MIT |
| `type-is` | 2.1.0 | MIT |
| `uc.micro` | 2.1.0 | MIT |
| `uc.micro` | 3.0.0 | MIT |
| `universalify` | 2.0.1 | MIT |
| `unpipe` | 1.0.0 | MIT |
| `vary` | 1.1.2 | MIT |
| `which` | 2.0.2 | ISC |
| `wrappy` | 1.0.2 | ISC |
| `ws` | 8.22.0 | MIT |
| `yallist` | 5.0.0 | BlueOak-1.0.0 |
| `yazl` | 3.3.1 | MIT |
| `zod` | 4.6.2 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |

### Desktop app — shipped tools

| Package | Version | Licence | Why it ships |
| --- | --- | --- | --- |
| `electron` | 43.7.0 | MIT | Electron runtime (bundles Chromium and Node.js; their notices ship in LICENSES.chromium.html) |
| `typescript` | 7.0.2 | Apache-2.0 | copied into the code-intelligence package for the TypeScript sidecar |

### Code intelligence service — NuGet packages

Published self-contained, so the .NET runtime (MIT) ships too.

| Package | Version | Licence |
| --- | --- | --- |
| `Microsoft.CodeAnalysis.Analyzers` | 5.9.0-1.26328.17 | MIT |
| `Microsoft.CodeAnalysis.Common` | 5.9.0 | MIT |
| `Microsoft.CodeAnalysis.CSharp` | 5.9.0 | MIT |
| `Microsoft.Data.Sqlite` | 10.0.13 | MIT |
| `Microsoft.Data.Sqlite.Core` | 10.0.13 | MIT |
| `Microsoft.ML.OnnxRuntime` | 1.31.0 | MIT |
| `Microsoft.ML.OnnxRuntime.Managed` | 1.31.0 | MIT |
| `SQLitePCLRaw.bundle_e_sqlite3` | 2.1.13 | Apache-2.0 |
| `SQLitePCLRaw.core` | 2.1.13 | Apache-2.0 |
| `SQLitePCLRaw.lib.e_sqlite3` | 2.1.13 | Apache-2.0 |
| `SQLitePCLRaw.provider.e_sqlite3` | 2.1.13 | Apache-2.0 |
| `System.Numerics.Tensors` | 9.0.0 | MIT |

### Phone app — pub packages

Runtime dependencies of `apps/praxis-mobile` (dev dependencies excluded). SDK packages are part of Flutter (BSD-3-Clause).

| Package | Version | Licence |
| --- | --- | --- |
| `args` | 2.7.0 | BSD-3-Clause |
| `async` | 2.13.1 | BSD-3-Clause |
| `clock` | 1.1.3 | Apache-2.0 |
| `code_assets` | 1.2.1 | BSD-3-Clause |
| `collection` | 1.19.1 | BSD-3-Clause |
| `cross_file` | 0.3.5+5 | BSD-3-Clause |
| `crypto` | 3.0.7 | BSD-3-Clause |
| `cryptography` | 2.9.0 | Apache-2.0 |
| `ffi` | 2.2.0 | BSD-3-Clause |
| `file` | 7.0.1 | BSD-3-Clause |
| `fixnum` | 1.1.1 | BSD-3-Clause |
| `flutter` | SDK | BSD-3-Clause |
| `flutter_plugin_android_lifecycle` | 2.0.35 | BSD-3-Clause |
| `flutter_secure_storage` | 9.2.4 | BSD-3-Clause |
| `flutter_secure_storage_linux` | 1.2.3 | BSD-3-Clause |
| `flutter_secure_storage_macos` | 3.1.3 | BSD-3-Clause |
| `flutter_secure_storage_platform_interface` | 1.1.2 | BSD-3-Clause |
| `flutter_secure_storage_web` | 1.2.1 | BSD-3-Clause |
| `flutter_secure_storage_windows` | 3.1.2 | BSD-3-Clause |
| `flutter_svg` | 2.3.0 | MIT |
| `flutter_web_plugins` | SDK | BSD-3-Clause |
| `hooks` | 2.0.2 | BSD-3-Clause |
| `http` | 1.6.0 | BSD-3-Clause |
| `http_parser` | 4.1.2 | BSD-3-Clause |
| `intl` | 0.20.3 | BSD-3-Clause |
| `jni` | 1.0.3 | BSD-3-Clause |
| `jni_flutter` | 1.0.3 | BSD-3-Clause |
| `jni_util` | 1.0.0 | BSD-3-Clause |
| `js` | 0.6.7 | BSD-3-Clause |
| `local_auth` | 2.3.0 | BSD-3-Clause |
| `local_auth_android` | 1.0.56 | BSD-3-Clause |
| `local_auth_darwin` | 1.6.1 | BSD-3-Clause |
| `local_auth_platform_interface` | 1.1.0 | BSD-3-Clause |
| `local_auth_windows` | 1.0.11 | BSD-3-Clause |
| `logging` | 1.3.0 | BSD-3-Clause |
| `meta` | 1.18.3 | BSD-3-Clause |
| `mime` | 2.1.0 | BSD-3-Clause |
| `mobile_scanner` | 7.4.2 | BSD-3-Clause |
| `nested` | 1.0.0 | MIT |
| `objective_c` | 9.5.0 | BSD-3-Clause |
| `package_config` | 3.0.0 | BSD-3-Clause |
| `path` | 1.9.1 | BSD-3-Clause |
| `path_parsing` | 1.1.0 | MIT |
| `path_provider` | 2.1.6 | BSD-3-Clause |
| `path_provider_android` | 2.3.1 | BSD-3-Clause |
| `path_provider_foundation` | 2.6.0 | BSD-3-Clause |
| `path_provider_linux` | 2.2.2 | BSD-3-Clause |
| `path_provider_platform_interface` | 2.1.3 | BSD-3-Clause |
| `path_provider_windows` | 2.3.0 | BSD-3-Clause |
| `petitparser` | 7.0.2 | MIT |
| `platform` | 3.2.0 | BSD-3-Clause |
| `plugin_platform_interface` | 2.1.8 | BSD-3-Clause |
| `provider` | 6.1.5+1 | MIT |
| `pub_semver` | 2.2.1 | BSD-3-Clause |
| `record_use` | 0.6.0 | BSD-3-Clause |
| `share_plus` | 10.1.4 | BSD-3-Clause |
| `share_plus_platform_interface` | 5.0.2 | BSD-3-Clause |
| `source_span` | 1.10.2 | BSD-3-Clause |
| `string_scanner` | 1.4.1 | BSD-3-Clause |
| `term_glyph` | 1.2.2 | BSD-3-Clause |
| `typed_data` | 1.4.0 | BSD-3-Clause |
| `url_launcher` | 6.3.2 | BSD-3-Clause |
| `url_launcher_android` | 6.3.33 | BSD-3-Clause |
| `url_launcher_ios` | 6.4.2 | BSD-3-Clause |
| `url_launcher_linux` | 3.2.3 | BSD-3-Clause |
| `url_launcher_macos` | 3.2.6 | BSD-3-Clause |
| `url_launcher_platform_interface` | 2.3.2 | BSD-3-Clause |
| `url_launcher_web` | 2.4.3 | BSD-3-Clause |
| `url_launcher_windows` | 3.1.6 | BSD-3-Clause |
| `uuid` | 4.6.0 | MIT |
| `vector_graphics` | 1.2.3 | BSD-3-Clause |
| `vector_graphics_codec` | 1.1.13 | BSD-3-Clause |
| `vector_graphics_compiler` | 1.3.0 | BSD-3-Clause |
| `vector_math` | 2.4.0 | BSD-3-Clause |
| `web` | 1.1.1 | BSD-3-Clause |
| `win32` | 5.15.0 | BSD-3-Clause |
| `xdg_directories` | 1.1.0 | BSD-3-Clause |
| `xml` | 7.0.1 | MIT |
| `yaml` | 3.1.4 | MIT |

<!-- licensing:generated:end -->
