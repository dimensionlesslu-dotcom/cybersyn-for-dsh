# Verification record

Tested on 2026-08-22 with Node.js 24.15.0, pnpm 11.19.0, DeepSeek Harness packages 0.1.1-rc.2, and Cordis 4.0.1.

| Check | Result | Evidence |
| --- | --- | --- |
| Strict TypeScript | PASS | `tsc -p tsconfig.json --noEmit` returned 0. |
| Unit and negative tests | PASS | 7 files, 23 tests. Covers graph validity, transitions, all-claim evidence, deviations, prompt invalidation/rollback, J-workspace capacity, L4 models, audit role routing, PromptPacket isolation, lifecycle transitions, one-retry cap, unmeasured/healthy/degraded states, token and quality regression, stale packets, JSONL audit replay, RPC ownership, tool binding, visualization, and pure-Skill shape. |
| Host/client build | PASS | Host ESM, invariant ESM, browser CJS module-loader bundle, and declarations built. |
| Cross-domain constructive examples | PASS | Software engineering, manufacturing quality, and scientific research all passed the same controller invariants. See `cross-domain-evidence.json`. |
| Packed-artifact smoke | PASS | `project-cybersyn-dsh-plugin-0.2.0.tgz` extracted; 14 required artifacts read; packed host entry loaded; seven tools and Skill registered; packed `cybersyn_start`, `cybersyn_audit_plan`, and `cybersyn_inspect` executed. |
| Production dependency audit | PASS | `pnpm audit --prod`: no known vulnerabilities. |

The skill-creator Python validator could not start because its own environment lacked `PyYAML`. Its documented validation rules were reproduced as a repository test (`tests/skill.spec.ts`) and passed. This is an environment limitation, not represented as an official-validator pass.

These checks demonstrate implementation invariants and packaging compatibility at the pinned preview version. They do not establish real-world causal effectiveness, future Harness compatibility, continuous-system stability, or access to a model's internal J-space.
