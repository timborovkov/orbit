-- Environments that already applied the Phase 2 migration with simulation_runs_one_active
-- need the index removed so maxConcurrentRuns > 1 can take effect.
DROP INDEX IF EXISTS simulation_runs_one_active;
