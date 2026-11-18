-- Fence simulation run updates to the worker claim that currently owns execution.
ALTER TABLE simulation_runs ADD COLUMN execution_token uuid;
