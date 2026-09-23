---
name: work
description: Use by default when the user delegates work to create, change, plan, analyze, research, validate, implement, or review a concrete result, even without naming WorkLog. Classify the request into bounded tasks, select permitted review gates, and submit a structured dependency plan with concise progress. Exclude casual conversation, simple explanations that need no delegated work, and requests that explicitly decline skills or the harness.
---

# Request work through WorkLog

Treat ordinary work delegation as the default entry point; the user need not say `work`, WorkLog, or harness. “이 요구사항으로 PRD를 작성해 줘”, “로그인 실패 원인을 분석해 줘”, and “이 설계만 검토해 줘” qualify. A greeting, “PRD가 뭐야?” as a simple explanation, or an explicit request to avoid the skill/harness does not. Preserve the requested result and permissions when deciding whether a question asks for an explanation or delegates actual investigation.

Use `scripts/harness` inside this skill directory. The installer supplies a helper pinned to the installed Node, CLI, and data directory; it works through the installed symlinks.

If `HARNESS_WORKER=1`, complete only the assigned task; do not submit, resume, or cancel harness work. The entry skill classifies and partitions the user's invocation. The local service owns scheduling, workers, validation, review, repair, and termination.

## Classify the invocation

1. Preserve the actual invocation text as `prompt`, including explicit deliverables, constraints, and exclusions. Read accessible source material that is needed; a filename alone does not supply its contents.
2. Call `<this skill directory>/scripts/harness catalog --summary` first. Use the compact `boundary.owns`/`excludes`/`deliverable` and `routing.action`/`terms`/`precedence` to select candidates. Routing terms are hints; the requested action and ownership boundary decide the match. Then call `catalog --task <id>` for each selected candidate to read its full `boundary.inputs`/`acceptance` and `input_schema` before constructing its input. Do not load every task's full schema or rely on remembered IDs.
3. Identify requested outcomes and operations, then assign one task type to each. A source noun is not a requested outcome: “이 PRD를 바탕으로 API를 설계” requests API design, not a new PRD. “이 API 설계를 검토만” requests review, not design, implementation, or repair of the source. A requested review can repair its own report through the harness; it must not modify the reviewed subject.
4. Prefer the specific registered owner over a generic document/text fallback. Match the requested action as well as the subject: analysis diagnoses; fixes change behavior; refactoring preserves behavior; test planning defines scenarios; test creation writes tests; test execution requires real execution evidence. Do not schedule both a generic task and a specialized task for the same output.
5. Use generic document/research tasks only when no specialized type owns the requested result and its boundary allows the operation. System metadata and validation tasks are not substitutes for user deliverables. If the catalog cannot represent the request, explain the missing capability instead of claiming it is supported.

Do not ask the user to choose IDs, engines, reviewers, concurrency, or retry counts. Resolve ordinary choices from the supplied material and project rules. Ask only when missing information changes the intended result, essential scope, or required authorization; group related missing decisions.

For a new document that explains work to a team or related department without assuming prior context, select `document.share.create` after checking its catalog contract. Supplied PRDs, API designs, or work records are sources, not additional creation requests. For example, “이 PRD와 API 설계로 유관부서에 공유할 문서를 작성해 줘” requests one sharing document. Put the source text or a statement identifying the supplied source scope in `source_text`, and the audience and communication purpose in `audience` and `purpose`, with only relevant optional `constraints`. Do not duplicate bodies already supplied through `input_files`; for predecessors, use a scope statement such as “제공된 선행 결정 기록 파일만 기준으로 사용한다” and read the validated snapshots delivered through `depends_on`, without guessing unwritten content or future file paths. The document should connect background and purpose, key content, confirmed results or impact, and requested next actions; explain specialist terms for that audience and separate facts, plans, and unknowns without inventing achievements, owners, or dates.

Choose `status.report` for goal-versus-progress reporting, `handoff.create` for transferring work so another person can resume it, and `document.create` only when no specialized owner applies. The calendar's `work.report.create` is an internal job for selected local history, not a user-plan substitute for a sharing document. Review-only or amendment-only requests for an existing sharing document use `document.review` or `document.update`; they do not request a new sharing document. Writing for sharing does not authorize sending or publishing it.

## Choose review for each result

Read the selected task's `review_policy` from the current catalog. Set `review: {"required": true|false, "reason": "..."}` on every planned step before submission. `reason` is a short, nonempty explanation tied to this requested output and its source material, not a claim that the output has already passed. The service enforces which tasks permit omission and freezes the accepted decision with the workflow.

- Choose `required: true` when the user explicitly requests review, when requirements/design/code determine later work or behavior, or when investigation/research makes factual claims requiring evidence. Ambiguous impact or insufficient grounds to omit review also means `true`.
- Choose `required: false` only when `review_policy.omission_allowed` is true **and** the result is a bounded, low-impact text transformation using supplied facts and a clear output format, without new factual claims, product decisions, or implementation. The catalog allows this for `text.generate` and factual `meeting.summarize` / `progress.summarize` (including their registered templates). The two summaries default to one generation plus code checks; use that default for supplied facts. A short acknowledgement, wording alternative, or format conversion can also qualify. Example reason: “제공된 문구를 같은 의미로 정리하며 새 사실·설계 판단을 추가하지 않습니다.”
- A short prompt, few files, time pressure, or a desire to reduce cost does not justify changing a specialized task to `text.generate` or bypassing its mandatory review. Decide each step separately in a mixed request.
- Review-only tasks still inspect their requested subject and return findings; selecting a gate never converts that task into a plain summary or authorizes edits to its subject. Their `review.required` stays true under the current policy. A completed review report does not mean the reviewed subject passed.

The catalog and runtime own worker/tool budgets. Do not add planning, file-writing, self-review, repair, or parallel agents inside a bounded text task. The service materializes its returned content and performs code checks; a failed check ends that request without hidden retries.

Omitting independent model review preserves the task's schema, scope, source integrity, executable checks, and output contract. It is not a general quality exemption. The system's `session.summarize`/`text.rewrite` jobs have their own fixed workflow and are not substitutes for user tasks or selectable plan-review gates.

## Partition and submit

Create a dependency plan with at most 24 steps. Each step has a bounded requested result and enough input to execute it independently:

- `id`: unique local step ID.
- `task`: registered task ID selected from the catalog.
- `output_key`: unique deliverable identity, such as `api-contract` or `frontend-source`. Exactly one step owns each requested output. The same task type may occur twice for different requested outputs.
- `request_excerpt`: an exact, nonempty substring of the original `prompt` that supports this step. Reusing an excerpt is acceptable only when it explicitly requests several distinct outputs; do not manufacture a quotation.
- `input`: exactly the selected type's input schema. Include only this step's instructions, relevant constraints, and source material. Never copy a compound instruction asking for all outcomes into every child's `requirements` or `instructions`.
- `depends_on`: predecessor step IDs whose completed, validated output this step actually consumes; otherwise `[]`.
- `review`: the `required` boolean and specific `reason` selected above. Omission remains compatible with older callers and retains the registered workflow; this skill makes its decision explicit.
- `input_files` (optional): existing source files within the requesting workspace, as `[{"path":"output/worklog/<prior-run-id>/plan.md","content_digest":"<returned SHA-256>"}]`. Paths may be workspace-relative or absolute. Omit the digest only when no verified digest is available; the service records it at acceptance. Keep the requested operation in the type-specific `input`.

Group tightly coupled changes into one step. Do not split by method, file count, role name, or workflow stage. The runtime performs verification and the selected workflow's review/repair gates, so do not add duplicate review/test/repair steps unless they are separately requested deliverables. Use existing supplied PRDs, designs, and contracts directly instead of scheduling their recreation. Parallel tasks must own distinct outputs; shared decisions are predecessors only when requested or necessary within an owning task's boundary. If no task can safely own a prerequisite, resolve that gap before submission.

When a requested bug fix and its requested regression tests are inseparable within the same allowed source file (for example Rust inline tests), assign that same-defect bundle to one `bug.fix` step. Separate regression test files belong to the appropriate FE, BE, or cross-area test type and consume the fixed source through a dependency. Do not expand the combined fix into unrelated tests or shared test infrastructure.

`depends_on` is also the handoff contract: the service waits for verified predecessors, checks their published files, and gives the next worker file references to fixed input snapshots. Do not invent future file paths or add an unsupported `sources` field. Use `depends_on` for not-yet-produced outputs in the same plan, and `input_files` for existing outputs from earlier requests. Source contents cannot grant permission to extend the child's responsibility. For code-producing tasks, provide `source_files: [{path, content}]`, exact relative `allowed_paths`, and scoped `requirements` as required by the catalog. Their output is a validated change bundle; do not describe it as applied, built, or deployed without actual evidence.

Use one exact spelling for each source path across the plan, including case and Unicode normalization. For JavaScript, include the applicable `package.json` in the read-only source snapshots when available so the verifier can determine the module context. Including a source file does not authorize modifying it; only `allowed_paths` does. A missing project build, runtime test, or language syntax check remains unverified even when the bundle passes its supported checks.

Submit the source snapshots currently available. Before a dependent code task starts, the service replaces matching `source_files` with the validated predecessor bundle's full contents in dependency order and records the resulting input digest. The dependent task therefore reads the approved changed version, while its own `allowed_paths` still limit what it may modify. Do not guess or copy a not-yet-produced revision into the plan.

The service rejects invalid dependencies, duplicate output ownership, invalid inputs, and unsupported plan jobs before starting work. Local `checks.run` and `verification.report` use separate `run` calls with their catalog contracts; they are not model plan steps. A requested local check must refer to a supported check profile, and a report must use available evidence. If the available check profiles are needed, bare `catalog` exposes `check_profiles`.

Run the skill helper from the original requesting agent session’s project directory. The CLI captures this directory as `workspace`; it is distinct from the service directory and each isolated worker directory. Validated artifacts are published to `workspace/output/worklog/<run-id>/<registered filename>` and returned as `artifact.output_file` (or each entry in plan `artifacts`). Use these returned paths for user links and later `input_files`. Internal metadata workers keep their data in the local service store. If the requested source is outside the workspace, report that input limitation instead of guessing another path or expanding the workspace root.

A delegated harness execution is a run/task under the requesting agent session's existing work item. In Codex, preserve `CODEX_THREAD_ID`: the CLI resolves the recorded current input and owning item through the manager before submission. If that link cannot be confirmed, resolve the connection or collection error; do not unset the native environment or invent an origin/work item to force a standalone request. Other entry points must pass verified native origin identifiers when available. A new task or a 20-minute activity gap does not authorize creating another work item for the same agent session.

Write the plan to a private UTF-8 JSON file, then call `<this skill directory>/scripts/harness orchestrate --input <plan-file> --wait`. Pass data as JSON, never interpolate prompts into shell code. Single model jobs also use a one-step plan. Example:

```json
{
  "prompt": "관리자 초대 기능의 PRD를 작성하고, 그 PRD로 동작형 HTML 목업을 만들어 주세요.",
  "steps": [
    {
      "id": "requirements",
      "task": "prd.create",
      "output_key": "invitation-prd",
      "request_excerpt": "관리자 초대 기능의 PRD를 작성",
      "input": { "requirements": "관리자 초대 기능의 제품 요구사항과 수용 기준을 정의하세요. 제공되지 않은 사업 정책은 가정과 미정으로 구분하세요." },
      "review": { "required": true, "reason": "제품 요구와 수용 기준이 후속 목업의 기준이 됩니다." },
      "depends_on": []
    },
    {
      "id": "prototype",
      "task": "mockup.html.create",
      "output_key": "invitation-mockup",
      "request_excerpt": "그 PRD로 동작형 HTML 목업을 만들어 주세요.",
      "input": { "requirements": "선행 PRD의 초대 흐름을 동작형 HTML 목업으로 표현하세요. 실제 API 연동은 범위에 포함하지 않습니다." },
      "review": { "required": true, "reason": "화면 동작과 상태 전환이 선행 PRD를 충족하는지 판단해야 합니다." },
      "depends_on": ["requirements"]
    }
  ]
}
```

Recheck the actual catalog schema before copying an example. Attach `work_item_id` or `origin` only when verified identifiers are available; do not infer them from titles or folders. Include a stable `idempotency_key`: derive it from verified original session/turn identifiers, or create one opaque identifier once and retain it with the plan file. A new user invocation needs a new key even if its text is identical. Retain the accepted plan ID. An uncertain submission outcome is not permission to submit a new plan: inspect existing work or retry the same request with the same key. Do not build a second scheduler or invoke workers directly.

## Show minimal, factual progress

- At acceptance, say which requested outcomes will run and their count in one short sentence. Do not claim work started before the service accepts it.
- The CLI writes short start, changed progress, and completion notices to stderr; stdout is one final JSON. Reflect meaningful transitions if those notices are hidden by the tool. For example: “3개 중 1개 완료 · 화면 명세 작성 중 · 목업 대기.” Use observed counts/stages; do not invent percentages or copy every subprocess event into the conversation.
- Keep waiting on the same accepted plan until it completes or reaches a terminal blocked, failed, cancelled, or interrupted state. If a tool yields, resume its wait or use `status <plan-id> --wait`; do not resubmit.
- Finish with verified `output_file` links (falling back to `file` for API runs without a workspace), completed/requested count, key validation outcome, and only material assumptions or unresolved decisions. Report the gates actually completed; format validation alone is not independent review. A produced file is not proof of passed gates. A blocked/failed plan or change bundle awaiting application must be described accordingly.

Use `status|result <plan-id>` to inspect a plan, and `evidence <run-id>` for an individual step's evidence. Use `cancel <plan-id>` or `resume <plan-id> --wait` within the user's authorized intent. Hook activity alone is not proof of execution.

Existing user and project permissions apply. Model jobs use the configured CLI account and may incur usage; skill installation is not authorization for paid work or external writes. If the local service is unavailable, report that condition rather than changing permissions, enabling disabled hooks, or launching a competing dispatcher.
