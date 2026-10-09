/qa-proxy-prepare $TEST_PLAN_PATH --out $PREPARE_OUT --no-docs

CI EXECUTION CONSTRAINTS (read before doing anything):
- This is a one-shot --print invocation with no human available. NEVER use AskUserQuestion - it cannot be answered. There is NO resumption: when you return, the workflow starts the QA proxy with whatever is in qa-proxy/scenarios/ and runs the cases.
- The plan may carry a `QA proxy scenarios` section (Markdown `## ... / ### \`name\`` or wiki `h3. ... / h4. {{name}}`): the case-writing step left it so each missing scenario can be written from the cases alone. `check_proxy_specs.mjs --json` returns it as `specifications`; hand each sub-agent its entry verbatim, as the skill's step 3 says. A scenario with no entry (`UNSPECIFIED_SCENARIO`) is still a need - the sub-agent derives it from the code.
- There is NO device in this step. Do not call adb or any mobile MCP tool, and tell every sub-agent the same. `/qa-proxy-scenario` Phase 6 (on-device check) is skipped; the QA run that follows confirms each scenario through `GET /log?modified=true`.
- Do NOT edit docs/ - it is a read-only checkout in CI. That is what `--no-docs` means: `/qa-proxy-scenario` Phase 7 is skipped.
- Do NOT commit, branch or push. The scenarios ship only as the patch in the run's artifact; a developer reviews and commits them.
- The generated scenarios run only inside the `qa-proxy` and `agent` containers on the compose network, with no `ports:` mapping and no secrets mounted into `qa-proxy`. Never add a port mapping, a secret, or a call to an external host to a scenario.
- Write all four outputs to $PREPARE_OUT/: qa_test_plan.resolved.md, scenarios.json, qa-proxy-scenarios.patch, status.txt. ALWAYS write status.txt (READY | PARTIAL | NONE_NEEDED | FAILED), even when the run fails - write FAILED with the files you got as far as. A missing status.txt is read as a crash.
- Do not run the QA cases and do not write a QA report. This step only prepares scenarios.
