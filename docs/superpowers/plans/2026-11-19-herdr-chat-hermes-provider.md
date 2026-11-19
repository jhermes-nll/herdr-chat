# hh-herdr-chat-hermes — fork herdr-chat and add a Hermes provider

<!-- hermes-handoff: ref=hh-herdr-chat-hermes repo=jhermes-nll/herdr-chat base=main clone=/Users/hermes/dev/herdr-chat test="npm test" -->

One task, one branch, one PR against your own fork. This is **not** a rewrite of herdr-chat and **not** an upstream change: a fork that gains a fourth chat backend, Hermes, next to the three that already work (pi, claude, codex). pi is already supported — do not touch it beyond keeping it working.

## Context

herdr-chat is the Herdr desktop app's native chat UI for coding-agent CLIs. Its chat mods render the timeline in the app; a hidden host process drives the agent CLI and turns its stream into chat events. Each supported agent is a **provider** inside the host, listed once in the launcher, and given a template plus an icon.

Jesse runs a Hermes agent on this Mac Studio (`hermes`, pi-bolt based, OpenAI-compatible api_server exposing model `hermes-agent`). He wants to talk to it in a Herdr chat pane the way he talks to pi today.

## Goal

On the studio: branch `feat/hermes-provider` in `/Users/hermes/dev/herdr-chat`, whose diff adds a `hermes` provider — selectable in the new-chat launcher, backed by a `hermes-chat` template, streaming a Hermes turn into the chat — `npm test` green, pushed, and an **open PR against `jhermes-nll/herdr-chat`**. Nothing merged, nothing installed into the running Herdr app.

## Inputs (verified 2026-11-19 on `ChmaraX/herdr-chat` `main`, MIT, actively released)

- `README.md` — "A native chat for Pi, Claude Code and Codex"; install copies mods into `~/.config/herdr-app/mods`; config lives in `~/.config/herdr-app/data/herdr-chat/settings.json` with one block per agent (`command`, `args`, `env`, `tui`).
- `docs/dev/providers.md` — **the authoritative how-to for adding a provider.** Read it first; it outranks anything below.
- `docs/dev/architecture.md`, `docs/dev/protocol.md` — host ⇄ mod wire protocol and the provider contract.
- `host/` — the provider host, TypeScript (`host/*.ts`), bundled to `bin/herdr-chat-host` by esbuild (`host/build.ts`). Provider registry: `host/main.js:162988-162997` in the installed bundle.
- `bin/herdr-chat-subagent` — what each chat template runs, per `--provider <name>`.
- `herdr-app/mods/new-chat/main.js:31` — `CHOICES`, the launcher's agent list.
- `herdr-app/mods/chat/icons/providers/` — `pi.svg`, `claude.svg`, `codex.svg`; a new provider needs its icon here.
- `herdr-app/mods/chat/{cards,questions,composer}.js` — approval cards, question cards, composer/steer; gates are per-provider capabilities.
- Templates on this machine: `~/.config/herdr-core/templates/pi-chat.md` and `claude-chat.md`, each mapping a name to `herdr-chat-subagent --provider …` (no `codex-chat` template exists — the launcher does not need one per provider).
- Hermes invocation, verified on this studio: `hermes -z "<prompt>"` returns one final string, no streaming (used by `~/.agents/skills/hermes-handoff/SKILL.md:64`). The api_server is OpenAI-compatible: `GET /v1/models` lists `hermes-agent`, `POST /v1/chat/completions` runs a real turn (~1s), SSE supported (verified 2026-11-18). Find its base URL/port and any API key in Hermes's own config on this machine — do not guess them.
- The fork already exists: `jhermes-nll/herdr-chat` (fork of `ChmaraX/herdr-chat`), cloned at `/Users/hermes/dev/herdr-chat` on this machine. Upstream `main` is unprotected, MIT (gate-verified 2026-11-19). Studio toolchain: node v26.13.0, npm 11.20.0.

## Decisions & Assumptions

D1. **Work in the existing fork**: `jhermes-nll/herdr-chat` (already forked from `ChmaraX/herdr-chat` and already cloned at `/Users/hermes/dev/herdr-chat`). Do **not** create another fork, do not re-clone. Branch `feat/hermes-provider` off `origin/main`. The PR targets **`jhermes-nll/herdr-chat`**, base `main` — never upstream `ChmaraX/herdr-chat`, which is Jesse's call. Because gate-verified 2026-11-19: this machine's `gh` is `jhermes-nll` and that fork/clone already exist.
D2. **Transport = the api_server over SSE**, not `hermes -z`. A chat needs token streaming and mid-turn cancel; `-z` yields only a final string. Because `docs/dev/protocol.md` defines providers as streaming event sources.
D3. **v1 capability set = text in, streamed text out, stop.** No tool cards, no approval cards, no steer, no model/effort pickers, no `/fork`, no resume. declare these absent through whatever capability mechanism `docs/dev/providers.md` prescribes, so the UI hides them. Because `cards.js`/`questions.js`/`composer.js` gates are per-provider, and Hermes's api has no equivalent of those surfaces yet.
D4. **Follow `docs/dev/providers.md` naming and file layout exactly.** If it says a provider is one file plus one registry entry plus one icon, that is the change — no new abstraction, no config schema of your own.
D5. **`npm test` is the gate** (host tests against fake agents, per `README.md` › Development). `npm run e2e` needs a private Herdr app — out of scope, do not run it. Node 20+ required; a checkout runs the TypeScript directly on Node 24.
D6. **Do not install into the running Herdr app and do not edit `~/.config/herdr-app/mods/*` or `~/.config/herdr-core/templates/*`.** The deliverable is the repo diff and the PR. Because the user's live app is in use, and install is `install.sh`'s job.

A1. The api_server is reachable on this machine with an API key Hermes already has. If it is not: implement the provider against the documented endpoint anyway, cover it with the fake-agent test style in `host/`, and record the unreachability under SKIPPED — do not switch to `-z` on your own.
A2. This machine's `gh` is `jhermes-nll` with push on the fork (gate-verified 2026-11-19). If `git push origin feat/hermes-provider` is rejected, stop and report under QUESTION — do not create a fork under another account, do not switch remotes.

## Items

1. **Evidence first.** In `/Users/hermes/dev/herdr-chat`: `git fetch origin && git switch main && git pull --ff-only`, `npm ci`; read `docs/dev/providers.md`, `docs/dev/architecture.md`, `docs/dev/protocol.md` and restate in your first reply: the provider interface (functions/types, file:line), how a provider is registered and surfaced in the launcher, and how capabilities are declared. If `docs/dev/providers.md` contradicts any Input above, the doc wins — note the correction.
2. Create branch `feat/hermes-provider` off `main`.
3. Add the `hermes` provider per the doc: the transport (SSE → the host's event shape), a `hermes` entry in `settings.json`-visible config handling (`command`/`args`/`env`/`baseUrl`-equivalent only if the doc's pattern calls for it), registry entry, `herdr-app/mods/new-chat/main.js` `CHOICES` entry, `herdr-app/mods/chat/icons/providers/hermes.svg`, and capability declarations per D3.
4. Add `hermes-chat` where templates are defined in this repo (see the Inputs line about templates); if templates are generated by `install.sh`/`RECIPE.md`, add it there instead and say so.
5. Test: extend the existing fake-agent test style in `host/` with a fake SSE server covering a full turn, an error response, and a cancel. No new test framework, no new dependency.
6. Docs: one `docs/dev/providers.md` addition or `README.md` Limitations line stating what Hermes chats cannot do (D3) and that it needs the api_server running.
7. **Verify:** `npm test` — all green, full output pasted in your final reply. Then `git status --porcelain` empty.
8. Commit in logical steps, push `feat/hermes-provider` to `origin` (the `jhermes-nll` fork), `gh pr create --repo jhermes-nll/herdr-chat --base main --head feat/hermes-provider` with a body stating what was added, what is deliberately absent (D3), and the test evidence. Print the PR URL.

## Definition of done

Every item done or listed under SKIPPED with its reason; `npm test` green with output pasted; `git status --porcelain` empty; branch pushed; PR open against the fork and its URL in your final reply; nothing merged, nothing installed.

## Non-goals

Upstream PR to `ChmaraX/herdr-chat`. Installing/activating the fork in the running app. Tool cards, approvals, steer, pickers, resume, `/fork`, cost meter. macOS/other-platform work beyond what already exists. Any change to the pi/claude/codex providers. Any change to Hermes's own configuration.

## Constraints

No new runtime dependency unless Item 5 cannot be met without one (then say which and why). Never force-push. Never merge. Never rewrite published history. Do not type into other Herdr terminals. All agent-facing names stay as they are.

## Risks

- **SSE shape mismatch** — Hermes's stream may not carry the fields the host's event model wants (no tool-call deltas, no usage). Mitigation: D3's reduced capability set is the contract; an unknown event must degrade to plain text, not crash the chat.
- **`docs/dev/providers.md` describes more than a text provider**, making D3's cut look like a broken provider. Mitigation: Item 6 documents it, and Item 1 surfaces the tension before code is written.
- **Fork vs upstream base confusion** — PR opened against `ChmaraX/herdr-chat` by mistake. Mitigation: D1, and Item 8 passes `--repo` explicitly.
