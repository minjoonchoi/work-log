---
name: worklog-request
description: Submit a user's requested work to the installed WorkLog harness and return the verified result. Use when the user asks WorkLog to carry out a task, or delegates an artifact request through WorkLog. The harness classifies the work and dispatches headless workers; this skill does not select task types or create its own orchestration loop.
---

# Request work through WorkLog

Use `scripts/harness` inside this skill directory. The installer supplies a helper pinned to the installed Node, CLI, and data directory; it works through the installed symlinks.

1. Preserve the user's desired result, constraints, and supplied material in a natural-language `prompt`. Read accessible source material that is needed and include the relevant content; a path is not automatically loaded as document contents. Do not ask the user to choose task IDs, engines, reviewers, or retry counts.
2. Write a UTF-8 request JSON file, then call `<this skill directory>/scripts/harness run --input <request-file> --wait`. Pass data as JSON instead of interpolating the prompt into shell code.

```json
{
  "prompt": "다음 요구사항으로 PRD를 작성해 주세요. 관리자는 팀원을 초대·취소하고 사용자는 초대를 수락·거절합니다."
}
```

3. The local harness classifies the request, normalizes its task/input contract, dispatches an approved headless worker, and owns verification, review, repair, and termination. Do not duplicate this orchestration or silently expand an unsupported request into additional jobs.
4. Return the requested artifacts, final status, key validation results, and material unresolved items. A blocked or failed run is not complete. Inspect the same run with `status`, `result`, or `evidence` when needed; cancel or resume only when the user requests it.

Add `work_item_id` or `origin` only when verified identifiers are available; do not infer them from titles or folders. Hook activity alone is not proof that the harness performed the requested work.

Existing user and project permissions apply. Model jobs use the configured CLI account and may incur usage; skill installation is not authorization for paid work or external writes. If `HARNESS_WORKER=1`, complete the assigned task instead of submitting another job. If the local service is unavailable, report that condition rather than changing permissions, enabling disabled hooks, or launching a competing dispatcher.
