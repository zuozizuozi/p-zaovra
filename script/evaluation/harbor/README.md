# Zaovra Harbor adapter

Standalone evaluation integration for Harbor **0.24.0**, Python **3.12+**. This directory is not part of the product build. Install Harbor into an evaluation-only virtual environment; put all runtime data and logs in the approved R&D records directory.

Import path: `zaovra_harbor:Zaovra` (add this directory to `PYTHONPATH`). The target environment must already contain the frozen Zaovra CLI. Options: `command` (argv prefix, default `['zaovra']`), `revision` (tested commit), `directory` (target workspace), `timeout_sec` (default 120), plus Harbor's `model_name`, `logs_dir` and `extra_env`. Provider configuration is supplied through the secret environment, not committed config. Do not point evaluations at a personal data profile.

The adapter invokes the real V2 `zaovra run --format json --thinking` command. It does not implement agent orchestration. Raw events and ATIF tool/observation links are retained; missing usage stays unknown, interrupted runs are not marked complete, and cache/reasoning components are counted once. Cost remains unknown unless independently priced.

Run regression tests from this directory with the evaluation venv's Python: `python -m unittest test_zaovra_harbor`.

The P0 native-process smoke covers CLI startup, two fixed-provider tasks, actual tools, natural exit, artifact checks and ATIF validation. It is **not** a containerized Harbor Trial or a benchmark score. Before P1, verify the frozen container image, full Job/Trial/Verifier path, durable partial logs and process cleanup on interruption. Set timeout from each official task rather than the P0 default. Do not silently enable retries, change the tasks or upload results.
